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

package aijob

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"sync"

	"helm.sh/helm/v3/pkg/cli"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	ctrl "sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/SUSE/aif-operator/api/v1alpha1"
	"github.com/SUSE/aif-operator/internal/controller/aiproject"
	helmClient "github.com/SUSE/aif-operator/internal/infra/helm"
	"github.com/SUSE/aif-operator/internal/infra/rancher"
)

// target is where a job's execution lives: the cluster, the namespace there,
// and the clients that reach it. A job without a pool runs on the operator's
// own cluster with the operator's own clients, as before pools existed.
type target struct {
	clusterID string
	namespace string
	helm      helmClient.HelmClient
	reader    ctrl.Reader
	logs      PodLogReader
	// pool is the ComputePool the job runs in; nil on the local cluster, and
	// after the pool was deleted (the placement still says where the job is).
	pool *v1alpha1.ComputePool
}

// unplaced is why a job cannot be reached yet: it waits, Pending, with this as
// the reason, and is tried again.
type unplaced struct {
	reason string
	msg    string
}

func (u unplaced) Error() string { return u.msg }

// notInProject is a job in an AI project's namespace that asks to run outside
// that project. The operator installs with the Settings token, so this check is
// what keeps a project's members inside their project. It fails the job.
type notInProject struct{ msg string }

func (n notInProject) Error() string { return n.msg }

// rancherProjectAnnotation is where Rancher records a namespace's project, as
// "<cluster>:<project>".
const rancherProjectAnnotation = "field.cattle.io/projectId"

// checkProject: a job in an AI project's namespace on local (internal/controller/aiproject)
// must run on that project's cluster, in one of that project's namespaces there. Jobs anywhere
// else were created by someone who can create AIJobs outside any project, an administrator.
func (r *AIJobReconciler) checkProject(ctx context.Context, job *v1alpha1.AIJob, t *target) error {
	home := &corev1.Namespace{}
	if err := r.Get(ctx, ctrl.ObjectKey{Name: job.Namespace}, home); err != nil {
		return ctrl.IgnoreNotFound(err)
	}
	cluster, project := home.Labels[aiproject.ClusterLabel], home.Labels[aiproject.ProjectLabel]
	if cluster == "" || project == "" {
		return nil
	}
	if t.clusterID != cluster {
		return notInProject{fmt.Sprintf("pool %s is on cluster %s, but this job belongs to project %s:%s", job.Spec.Pool, t.clusterID, cluster, project)}
	}
	target := &corev1.Namespace{}
	switch err := t.reader.Get(ctx, ctrl.ObjectKey{Name: t.namespace}, target); {
	case apierrors.IsNotFound(err):
		return unplaced{"TargetNamespaceNotFound", fmt.Sprintf("namespace %s does not exist on cluster %s", t.namespace, t.clusterID)}
	case err != nil:
		return err
	}
	if got := target.Annotations[rancherProjectAnnotation]; got != cluster+":"+project {
		return notInProject{fmt.Sprintf("namespace %s on cluster %s is not in project %s:%s", t.namespace, t.clusterID, cluster, project)}
	}
	return nil
}

// targetFor resolves where the job runs. Once installed, the placement in its
// status decides, so a deleted pool does not strand the release.
func (r *AIJobReconciler) targetFor(ctx context.Context, job *v1alpha1.AIJob) (*target, error) {
	t := &target{clusterID: rancher.LocalClusterID, namespace: job.Namespace}
	if job.Spec.TargetNamespace != "" {
		t.namespace = job.Spec.TargetNamespace
	}
	placed := job.Status.Placement
	if job.Spec.Pool != "" {
		pool := &v1alpha1.ComputePool{}
		switch err := r.Get(ctx, ctrl.ObjectKey{Name: job.Spec.Pool}, pool); {
		case err == nil:
			if pool.Spec.Disabled && placed == nil {
				return nil, unplaced{"PoolDisabled", fmt.Sprintf("compute pool %s is disabled", job.Spec.Pool)}
			}
			t.pool, t.clusterID = pool, pool.Spec.ClusterID
		case apierrors.IsNotFound(err) && placed != nil:
			t.clusterID = placed.ClusterID
		case apierrors.IsNotFound(err):
			return nil, unplaced{"PoolNotFound", fmt.Sprintf("compute pool %s does not exist", job.Spec.Pool)}
		default:
			return nil, err
		}
	}
	if placed != nil {
		t.clusterID, t.namespace = placed.ClusterID, placed.Namespace
	}

	var err error
	if t.clusterID == rancher.LocalClusterID {
		t.reader, t.logs = r.APIReader, r.PodLogs
		t.helm, err = r.helmFor(t.clusterID, t.namespace, nil)
		return t, err
	}
	conn := r.Connection.Get()
	if conn == nil {
		return nil, unplaced{"NoRancherToken", "cluster " + t.clusterID + " is reached through Rancher: " + rancher.ErrNoConnection.Error()}
	}
	if t.reader, t.logs, err = r.remoteFor(t.clusterID, conn); err != nil {
		return nil, err
	}
	if placed == nil {
		if err := r.checkProject(ctx, job, t); err != nil {
			return nil, err
		}
	}
	t.helm, err = r.helmFor(t.clusterID, t.namespace, conn)
	return t, err
}

// remoteFor is a reader and a log reader for a downstream cluster through
// Rancher's proxy, reused until the connection changes.
func (r *AIJobReconciler) remoteFor(clusterID string, conn *rancher.Connection) (ctrl.Reader, PodLogReader, error) {
	if r.RemoteFor != nil {
		return r.RemoteFor(clusterID)
	}
	key := clusterID + "|" + fingerprint(conn)
	if v, ok := r.remotes.Load(key); ok {
		rc := v.(remoteClients)
		return rc.reader, rc.logs, nil
	}
	cfg, err := rancher.ClusterConfig(conn, clusterID)
	if err != nil {
		return nil, nil, err
	}
	c, err := ctrl.New(cfg, ctrl.Options{Scheme: r.Scheme})
	if err != nil {
		return nil, nil, err
	}
	logs, err := NewPodLogReader(cfg)
	if err != nil {
		return nil, nil, err
	}
	r.remotes.Store(key, remoteClients{reader: c, logs: logs})
	return c, logs, nil
}

type remoteClients struct {
	reader ctrl.Reader
	logs   PodLogReader
}

// helmFor is a Helm client for a namespace of a cluster: in-cluster for local,
// through Rancher's proxy otherwise. Reused until the connection changes.
func (r *AIJobReconciler) helmFor(clusterID, namespace string, conn *rancher.Connection) (helmClient.HelmClient, error) {
	key := clusterID + "|" + namespace + "|" + fingerprint(conn)
	if c, ok := r.helmClients.Load(key); ok {
		return c.(helmClient.HelmClient), nil
	}
	var (
		c   helmClient.HelmClient
		err error
	)
	if r.HelmFor != nil {
		c, err = r.HelmFor(clusterID, namespace)
	} else {
		c, err = newHelmClient(clusterID, namespace, conn)
	}
	if err != nil {
		return nil, err
	}
	actual, _ := r.helmClients.LoadOrStore(key, c)
	return actual.(helmClient.HelmClient), nil
}

func newHelmClient(clusterID, namespace string, conn *rancher.Connection) (helmClient.HelmClient, error) {
	s := cli.New()
	s.SetNamespace(namespace)
	if clusterID != rancher.LocalClusterID {
		cfg, err := rancher.ClusterConfig(conn, clusterID)
		if err != nil {
			return nil, err
		}
		s.KubeAPIServer, s.KubeToken, s.KubeInsecureSkipTLSVerify = cfg.Host, cfg.BearerToken, cfg.Insecure
		if len(cfg.CAData) > 0 {
			// Helm takes the CA as a file only.
			f, err := caFile(cfg.CAData)
			if err != nil {
				return nil, err
			}
			s.KubeCaFile = f
		}
	}
	return helmClient.New(s)
}

var caFiles sync.Map // CA fingerprint -> file path

// caFile writes a CA bundle to a file once and returns its path.
func caFile(pem []byte) (string, error) {
	sum := sha256.Sum256(pem)
	key := hex.EncodeToString(sum[:8])
	if p, ok := caFiles.Load(key); ok {
		return p.(string), nil
	}
	f, err := os.CreateTemp("", "rancher-ca-*.pem")
	if err != nil {
		return "", err
	}
	defer f.Close()
	if _, err := f.Write(pem); err != nil {
		return "", errors.Join(err, os.Remove(f.Name()))
	}
	caFiles.Store(key, f.Name())
	return f.Name(), nil
}

// fingerprint identifies a connection without holding its token in a map key.
func fingerprint(c *rancher.Connection) string {
	if c == nil {
		return ""
	}
	h := sha256.New()
	_, _ = fmt.Fprintf(h, "%s\x00%s\x00%t\x00", c.URL, c.Token, c.Insecure)
	h.Write(c.CAPEM)
	return hex.EncodeToString(h.Sum(nil)[:8])
}
