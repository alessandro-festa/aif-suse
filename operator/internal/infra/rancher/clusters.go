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

package rancher

import (
	"errors"
	"strings"
	"sync"

	"k8s.io/client-go/rest"
)

// Connection is how the operator reaches Rancher's API: its URL, a Rancher API
// token and the CA to trust. The Settings controller resolves it from
// Settings.Spec.RancherCatalog, the same token the catalog client uses.
type Connection struct {
	URL      string
	Token    string
	CAPEM    []byte
	Insecure bool
}

// ConnectionHolder is a concurrency-safe slot for the current Connection, set
// by the Settings controller and read by controllers that reach downstream
// clusters. nil means no Rancher token is configured.
type ConnectionHolder struct {
	mu       sync.RWMutex
	c        *Connection
	resolved bool
}

// NewConnectionHolder returns an empty holder.
func NewConnectionHolder() *ConnectionHolder { return &ConnectionHolder{} }

// Get returns the current connection, or nil.
func (h *ConnectionHolder) Get() *Connection {
	if h == nil {
		return nil
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.c
}

// Set replaces the current connection; nil clears it. Either way the
// connection is now resolved.
func (h *ConnectionHolder) Set(c *Connection) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.c, h.resolved = c, true
}

// Resolved says whether the Settings controller has read Settings yet. Until it
// has, a nil connection means "not known yet", not "no token": right after the
// operator starts, controllers run before Settings is read.
func (h *ConnectionHolder) Resolved() bool {
	if h == nil {
		return false
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.resolved
}

// LocalClusterID is the Rancher ID of the cluster Rancher (and the operator)
// run on.
const LocalClusterID = "local"

// ErrNoConnection means a downstream cluster was asked for but no Rancher token
// is configured in Settings.
var ErrNoConnection = errors.New("no Rancher API token configured in AI Factory Settings (rancherCatalog.tokenSecretRef)")

// ErrConnectionPending means Settings has not been read yet, so whether there is
// a Rancher token is not known: try again shortly, and do not report the cluster
// as unreachable.
var ErrConnectionPending = errors.New("the Rancher connection from AI Factory Settings is not known yet")

// ClusterConfig is the REST config that reaches a cluster through Rancher's
// proxy, <rancher>/k8s/clusters/<id>, authenticated with the connection's
// token. The proxy enforces that token's Rancher permissions on that cluster.
func ClusterConfig(c *Connection, clusterID string) (*rest.Config, error) {
	if c == nil || c.Token == "" {
		return nil, ErrNoConnection
	}
	tls := rest.TLSClientConfig{CAData: c.CAPEM}
	if c.Insecure {
		// client-go refuses a CA together with skip-verify ("specifying a root
		// certificates file with the insecure flag is not allowed"), and the
		// Settings controller discovers Rancher's internal CA even when
		// insecureSkipVerify is set. Skip-verify wins, as for the catalog client.
		tls = rest.TLSClientConfig{Insecure: true}
	}
	return &rest.Config{
		Host:            strings.TrimSuffix(c.URL, "/") + "/k8s/clusters/" + clusterID,
		BearerToken:     c.Token,
		TLSClientConfig: tls,
	}, nil
}
