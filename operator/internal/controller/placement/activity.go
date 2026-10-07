/*
Copyright 2025.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package placement

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"sync"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"

	"github.com/SUSE/aif-operator/api/v1alpha1"
	"github.com/SUSE/aif-operator/internal/infra/rancher"
)

// How a run's activity is read, without Prometheus: the kubelet's stats summary
// for CPU, the NVIDIA DCGM exporter's metrics for GPUs, both through the Rancher
// proxy. A sample is a point in time; the idle window is kept on the AIJob.

// DCGMExporterSelector finds the DCGM exporter's Service (GPU Operator).
const DCGMExporterSelector = "app=nvidia-dcgm-exporter"

// Probe reads what activity sampling needs from a downstream cluster.
type Probe interface {
	// Pods are the run's pods in its namespace there.
	Pods(ctx context.Context, clusterID, namespace, jobID string) ([]corev1.Pod, error)
	// NodeStats is a node's kubelet stats summary.
	NodeStats(ctx context.Context, clusterID, node string) ([]byte, error)
	// GPUMetrics is the DCGM exporter's metrics; nil when the cluster has none.
	GPUMetrics(ctx context.Context, clusterID string) ([]byte, error)
}

type statsSummary struct {
	Pods []struct {
		PodRef struct {
			Name      string `json:"name"`
			Namespace string `json:"namespace"`
		} `json:"podRef"`
		CPU *struct {
			UsageNanoCores *uint64 `json:"usageNanoCores"`
		} `json:"cpu"`
	} `json:"pods"`
}

// cpuUtilisation is the run's CPU use against its CPU request, in percent: the
// usage of its running pods, from their nodes' stats summaries, over the sum of
// their requests (their limits when they request none). ok is false when no pod
// can be read.
func cpuUtilisation(pods []corev1.Pod, summaries map[string][]byte) (pct int32, ok bool) {
	usage := map[string]uint64{}
	seen := map[string]bool{}
	for _, raw := range summaries {
		var s statsSummary
		if json.Unmarshal(raw, &s) != nil {
			continue
		}
		for _, p := range s.Pods {
			if p.CPU != nil && p.CPU.UsageNanoCores != nil {
				key := p.PodRef.Namespace + "/" + p.PodRef.Name
				usage[key] = *p.CPU.UsageNanoCores
				seen[key] = true
			}
		}
	}
	var used, requested int64
	for i := range pods {
		p := &pods[i]
		key := p.Namespace + "/" + p.Name
		if p.Status.Phase != corev1.PodRunning || !seen[key] {
			continue
		}
		var req int64
		for _, c := range p.Spec.Containers {
			if q, has := c.Resources.Requests[corev1.ResourceCPU]; has {
				req += q.MilliValue()
			} else if q, has := c.Resources.Limits[corev1.ResourceCPU]; has {
				req += q.MilliValue()
			}
		}
		if req == 0 {
			req = 1000 // no request and no limit: count it against one core
		}
		used += int64(usage[key] / 1e6) // nanocores → millicores
		requested += req
		ok = true
	}
	if !ok {
		return 0, false
	}
	return percent(used, requested), true
}

var dcgmLine = regexp.MustCompile(`^DCGM_FI_DEV_GPU_UTIL\{([^}]*)\}\s+([0-9.eE+-]+)`)
var dcgmLabel = regexp.MustCompile(`(\w+)="([^"]*)"`)

// gpuUtilisation is the average utilisation of the GPUs the DCGM exporter
// attributes to the run's pods, in percent. ok is false when it attributes none
// to them (an exporter without pod mapping, or no GPU in use yet).
func gpuUtilisation(metrics []byte, namespace string, pods []string) (pct int32, ok bool) {
	want := map[string]bool{}
	for _, p := range pods {
		want[p] = true
	}
	var sum float64
	var n int
	sc := bufio.NewScanner(bytes.NewReader(metrics))
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		m := dcgmLine.FindStringSubmatch(sc.Text())
		if m == nil {
			continue
		}
		labels := map[string]string{}
		for _, l := range dcgmLabel.FindAllStringSubmatch(m[1], -1) {
			labels[l[1]] = l[2]
		}
		if labels["namespace"] != namespace || !want[labels["pod"]] {
			continue
		}
		v, err := strconv.ParseFloat(m[2], 64)
		if err != nil {
			continue
		}
		sum += v
		n++
	}
	if n == 0 {
		return 0, false
	}
	return int32(sum/float64(n) + 0.5), true
}

func percent(part, whole int64) int32 {
	if whole <= 0 {
		return 0
	}
	p := (part*100 + whole/2) / whole
	if p > 100 {
		p = 100 // a pod may burst above its request
	}
	return int32(p)
}

// sample reads the run's utilisation now: its GPUs on a GPU pool when the
// exporter can attribute them, else its CPU.
func sample(ctx context.Context, probe Probe, j *v1alpha1.AIJob, pool *v1alpha1.ComputePool) (pct int32, source string, err error) {
	at := j.Status.Placement
	pods, err := probe.Pods(ctx, at.ClusterID, at.Namespace, j.Name)
	if err != nil {
		return 0, "", fmt.Errorf("read the run's pods: %w", err)
	}
	cpuSource := "cpu"
	if pool.Spec.Kind == v1alpha1.ComputePoolKindGPU {
		names := make([]string, 0, len(pods))
		for i := range pods {
			names = append(names, pods[i].Name)
		}
		metrics, err := probe.GPUMetrics(ctx, at.ClusterID)
		switch {
		case err != nil:
			cpuSource = "cpu (GPU metrics unreadable: " + err.Error() + ")"
		case metrics == nil:
			cpuSource = "cpu (no DCGM exporter on the cluster)"
		default:
			if pct, ok := gpuUtilisation(metrics, at.Namespace, names); ok {
				return pct, "gpu", nil
			}
			cpuSource = "cpu (the DCGM exporter attributes no GPU to the run's pods)"
		}
	}
	summaries := map[string][]byte{}
	for i := range pods {
		node := pods[i].Spec.NodeName
		if node == "" || summaries[node] != nil {
			continue
		}
		raw, err := probe.NodeStats(ctx, at.ClusterID, node)
		if err != nil {
			return 0, "", fmt.Errorf("read node %s stats: %w", node, err)
		}
		summaries[node] = raw
	}
	pct, ok := cpuUtilisation(pods, summaries)
	if !ok {
		return 0, "", fmt.Errorf("no running pod of the run is in its nodes' stats")
	}
	return pct, cpuSource, nil
}

// ProxyProbe reads downstream clusters through the Rancher proxy with the
// Settings token. Clients are reused until the connection changes.
type ProxyProbe struct {
	Connection *rancher.ConnectionHolder

	mu      sync.Mutex
	clients map[string]proxyClient
}

type proxyClient struct {
	conn rancher.Connection
	cs   kubernetes.Interface
}

func (p *ProxyProbe) client(clusterID string) (kubernetes.Interface, error) {
	if !p.Connection.Resolved() {
		return nil, rancher.ErrConnectionPending
	}
	conn := p.Connection.Get()
	if conn == nil {
		return nil, rancher.ErrNoConnection
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if c, ok := p.clients[clusterID]; ok && c.conn.URL == conn.URL && c.conn.Token == conn.Token &&
		c.conn.Insecure == conn.Insecure && string(c.conn.CAPEM) == string(conn.CAPEM) {
		return c.cs, nil
	}
	cfg, err := rancher.ClusterConfig(conn, clusterID)
	if err != nil {
		return nil, err
	}
	cs, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, err
	}
	if p.clients == nil {
		p.clients = map[string]proxyClient{}
	}
	p.clients[clusterID] = proxyClient{conn: *conn, cs: cs}
	return cs, nil
}

func (p *ProxyProbe) Pods(ctx context.Context, clusterID, namespace, jobID string) ([]corev1.Pod, error) {
	cs, err := p.client(clusterID)
	if err != nil {
		return nil, err
	}
	list, err := cs.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{LabelSelector: v1alpha1.AIJobJobIDLabel + "=" + jobID})
	if err != nil {
		return nil, err
	}
	return list.Items, nil
}

func (p *ProxyProbe) NodeStats(ctx context.Context, clusterID, node string) ([]byte, error) {
	cs, err := p.client(clusterID)
	if err != nil {
		return nil, err
	}
	return cs.CoreV1().RESTClient().Get().AbsPath("/api/v1/nodes", node, "proxy/stats/summary").DoRaw(ctx)
}

func (p *ProxyProbe) GPUMetrics(ctx context.Context, clusterID string) ([]byte, error) {
	cs, err := p.client(clusterID)
	if err != nil {
		return nil, err
	}
	svcs, err := cs.CoreV1().Services("").List(ctx, metav1.ListOptions{LabelSelector: DCGMExporterSelector})
	if err != nil {
		return nil, err
	}
	for _, s := range svcs.Items {
		if len(s.Spec.Ports) == 0 {
			continue
		}
		port := strconv.Itoa(int(s.Spec.Ports[0].Port))
		return cs.CoreV1().RESTClient().Get().
			AbsPath("/api/v1/namespaces", s.Namespace, "services", s.Name+":"+port, "proxy/metrics").DoRaw(ctx)
	}
	return nil, nil
}

// parseIdleDuration reads "30m", "2h" or "3d".
func parseIdleDuration(s string) (minutes int64, err error) {
	if len(s) < 2 {
		return 0, fmt.Errorf("duration %q: want a number and m, h or d", s)
	}
	n, err := strconv.ParseInt(s[:len(s)-1], 10, 64)
	if err != nil || n <= 0 {
		return 0, fmt.Errorf("duration %q: want a positive number and m, h or d", s)
	}
	switch strings.ToLower(s[len(s)-1:]) {
	case "m":
		return n, nil
	case "h":
		return n * 60, nil
	case "d":
		return n * 60 * 24, nil
	}
	return 0, fmt.Errorf("duration %q: the unit is m, h or d", s)
}
