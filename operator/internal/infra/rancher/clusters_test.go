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
	"testing"

	"k8s.io/client-go/rest"
)

func TestClusterConfigGoesThroughRancherWithTheToken(t *testing.T) {
	cfg, err := ClusterConfig(&Connection{URL: "https://rancher.cattle-system.svc/", Token: "token-x:y", CAPEM: []byte("pem")}, "c-abc")
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Host != "https://rancher.cattle-system.svc/k8s/clusters/c-abc" {
		t.Errorf("host = %q", cfg.Host)
	}
	if cfg.BearerToken != "token-x:y" || string(cfg.CAData) != "pem" || cfg.Insecure {
		t.Errorf("auth/tls = %q %q %v", cfg.BearerToken, cfg.CAData, cfg.Insecure)
	}
}

// Settings can say insecureSkipVerify while the internal CA is also discovered.
// client-go rejects a CA with skip-verify, so the client would never be built.
func TestClusterConfigWithSkipVerifyDropsTheCA(t *testing.T) {
	cfg, err := ClusterConfig(&Connection{URL: "https://r", Token: "t", CAPEM: []byte("pem"), Insecure: true}, "c-abc")
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.Insecure || len(cfg.CAData) != 0 {
		t.Errorf("insecure=%v caData=%q, want skip-verify and no CA", cfg.Insecure, cfg.CAData)
	}
	if _, err := rest.HTTPClientFor(cfg); err != nil {
		t.Errorf("client-go rejects the config: %v", err)
	}
}

func TestClusterConfigWithoutATokenSaysSo(t *testing.T) {
	for _, c := range []*Connection{nil, {URL: "https://r"}} {
		if _, err := ClusterConfig(c, "c-abc"); !errors.Is(err, ErrNoConnection) {
			t.Errorf("ClusterConfig(%v) error = %v, want ErrNoConnection", c, err)
		}
	}
	var h *ConnectionHolder
	if h.Get() != nil {
		t.Error("a nil holder has no connection")
	}
}
