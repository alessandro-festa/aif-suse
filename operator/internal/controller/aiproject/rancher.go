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

package aiproject

import (
	"context"
	"sync"

	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/SUSE/aif-operator/internal/infra/rancher"
)

// TokenRancher reaches Rancher through its proxy with the Settings token: the
// management API as <rancher>/k8s/clusters/local, each downstream cluster as
// <rancher>/k8s/clusters/<id>. Requests are made as the token's user, so
// Rancher's own checks on who may grant a role apply to what the operator
// writes. Clients are reused until the connection changes.
type TokenRancher struct {
	Connection *rancher.ConnectionHolder
	Scheme     *runtime.Scheme

	mu      sync.Mutex
	clients map[string]cachedClient
}

type cachedClient struct {
	conn   rancher.Connection
	client ctrl.Client
}

func (t *TokenRancher) Management(ctx context.Context) (ctrl.Client, error) {
	return t.Cluster(ctx, rancher.LocalClusterID)
}

func (t *TokenRancher) Cluster(_ context.Context, clusterID string) (ctrl.Client, error) {
	if !t.Connection.Resolved() {
		return nil, rancher.ErrConnectionPending
	}
	conn := t.Connection.Get()
	if conn == nil {
		return nil, rancher.ErrNoConnection
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if c, ok := t.clients[clusterID]; ok && c.conn.URL == conn.URL && c.conn.Token == conn.Token &&
		c.conn.Insecure == conn.Insecure && string(c.conn.CAPEM) == string(conn.CAPEM) {
		return c.client, nil
	}
	cfg, err := rancher.ClusterConfig(conn, clusterID)
	if err != nil {
		return nil, err
	}
	c, err := ctrl.New(cfg, ctrl.Options{Scheme: t.Scheme})
	if err != nil {
		return nil, err
	}
	if t.clients == nil {
		t.clients = map[string]cachedClient{}
	}
	t.clients[clusterID] = cachedClient{conn: *conn, client: c}
	return c, nil
}
