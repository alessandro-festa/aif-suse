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

package computepool

import (
	"context"
	"sync"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/fields"
	"k8s.io/client-go/discovery"
	"k8s.io/client-go/kubernetes"
	ctrl "sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/SUSE/aif-operator/internal/infra/rancher"
)

// Access opens a cluster for reading. Abstracted so the reconciler can be
// tested without a Rancher in front of real clusters.
type Access interface {
	For(ctx context.Context, clusterID string) (ClusterReader, error)
}

// ClusterReader is the little discovery reads of one cluster.
type ClusterReader interface {
	Nodes(ctx context.Context) ([]corev1.Node, error)
	Pods(ctx context.Context) ([]corev1.Pod, error)
	APIGroups(ctx context.Context) ([]string, error)
	// NodeStats is a node's kubelet stats summary (what its pods use now).
	NodeStats(ctx context.Context, node string) ([]byte, error)
}

// RancherAccess reads downstream clusters through Rancher's proxy with the
// Settings token.
type RancherAccess struct {
	// Connection is the Rancher URL, token and CA, set by the Settings
	// controller; nil until a token is configured.
	Connection *rancher.ConnectionHolder

	mu      sync.Mutex
	clients map[string]cachedClient
}

type cachedClient struct {
	conn   rancher.Connection
	reader *clusterReader
}

// For returns a proxy reader for the cluster. Proxy clients are reused until
// the connection changes (a new token, URL or CA).
func (a *RancherAccess) For(_ context.Context, clusterID string) (ClusterReader, error) {
	if !a.Connection.Resolved() {
		return nil, rancher.ErrConnectionPending
	}
	conn := a.Connection.Get()
	if conn == nil {
		return nil, rancher.ErrNoConnection
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if cc, ok := a.clients[clusterID]; ok && sameConnection(cc.conn, *conn) {
		return cc.reader, nil
	}
	cfg, err := rancher.ClusterConfig(conn, clusterID)
	if err != nil {
		return nil, err
	}
	c, err := ctrl.New(cfg, ctrl.Options{})
	if err != nil {
		return nil, err
	}
	d, err := discovery.NewDiscoveryClientForConfig(cfg)
	if err != nil {
		return nil, err
	}
	cs, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, err
	}
	r := &clusterReader{c: c, d: d, cs: cs}
	if a.clients == nil {
		a.clients = map[string]cachedClient{}
	}
	a.clients[clusterID] = cachedClient{conn: *conn, reader: r}
	return r, nil
}

func sameConnection(a, b rancher.Connection) bool {
	return a.URL == b.URL && a.Token == b.Token && a.Insecure == b.Insecure && string(a.CAPEM) == string(b.CAPEM)
}

type clusterReader struct {
	c  ctrl.Reader
	d  discovery.DiscoveryInterface
	cs kubernetes.Interface
}

func (r *clusterReader) NodeStats(ctx context.Context, node string) ([]byte, error) {
	return r.cs.CoreV1().RESTClient().Get().AbsPath("/api/v1/nodes", node, "proxy/stats/summary").DoRaw(ctx)
}

func (r *clusterReader) Nodes(ctx context.Context) ([]corev1.Node, error) {
	l := &corev1.NodeList{}
	if err := r.c.List(ctx, l); err != nil {
		return nil, err
	}
	return l.Items, nil
}

// activePods skips finished pods server-side: they request nothing, and on a
// busy cluster they are most of the list.
var activePods = fields.ParseSelectorOrDie("status.phase!=Succeeded,status.phase!=Failed")

func (r *clusterReader) Pods(ctx context.Context) ([]corev1.Pod, error) {
	l := &corev1.PodList{}
	if err := r.c.List(ctx, l, ctrl.MatchingFieldsSelector{Selector: activePods}); err != nil {
		return nil, err
	}
	return l.Items, nil
}

func (r *clusterReader) APIGroups(_ context.Context) ([]string, error) {
	gl, err := r.d.ServerGroups()
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(gl.Groups))
	for _, g := range gl.Groups {
		out = append(out, g.Name)
	}
	return out, nil
}
