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
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/pem"
	"math/big"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"sigs.k8s.io/controller-runtime/pkg/client"

	"github.com/SUSE/aif-operator/api/v1alpha1"
)

// setRepo changes the harness's gpu-train-charts ClusterRepo.
func (h *harness) setRepo(fields map[string]interface{}) {
	h.t.Helper()
	repo := &unstructured.Unstructured{}
	repo.SetGroupVersionKind(clusterRepoGVK)
	require.NoError(h.t, h.c.Get(context.Background(), client.ObjectKey{Name: "gpu-train-charts"}, repo))
	for k, v := range fields {
		require.NoError(h.t, unstructured.SetNestedField(repo.Object, v, "spec", k))
	}
	require.NoError(h.t, h.c.Update(context.Background(), repo))
}

func testCA(t *testing.T) string {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	require.NoError(t, err)
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "test registry CA"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	require.NoError(t, err)
	return base64.StdEncoding.EncodeToString(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}))
}

func TestARepoThatSkipsTLSVerificationIsRefusedUnlessTheOperatorAllowsIt(t *testing.T) {
	h := newHarness(t, aijob("train-1"))
	h.setRepo(map[string]interface{}{"url": "oci://registry.example.com/charts", "insecureSkipTLSVerify": true})
	h.reconcile("train-1")
	j := h.get("train-1")
	assert.Empty(t, h.helm.ensured, "no pull with verification off unless the operator was deployed allowing it")
	assert.Equal(t, v1alpha1.AIJobPhaseFailed, j.Status.Phase)
	assert.Contains(t, j.Status.Result.Message, "allowInsecureRegistryTLS")

	h2 := newHarness(t, aijob("train-2"))
	h2.r.AllowInsecureRegistryTLS = true
	h2.setRepo(map[string]interface{}{"url": "oci://registry.example.com/charts", "insecureSkipTLSVerify": true})
	h2.reconcile("train-2")
	require.Len(t, h2.helm.ensured, 1)
	require.NotNil(t, h2.helm.ensured[0].TLSConfig)
	assert.True(t, h2.helm.ensured[0].TLSConfig.InsecureSkipVerify)
}

func TestARepoCABundleIsTrustedForThePull(t *testing.T) {
	h := newHarness(t, aijob("train-1"))
	h.setRepo(map[string]interface{}{"url": "oci://registry.example.com/charts", "caBundle": testCA(t)})
	h.reconcile("train-1")
	require.Len(t, h.helm.ensured, 1)
	cfg := h.helm.ensured[0].TLSConfig
	require.NotNil(t, cfg)
	assert.False(t, cfg.InsecureSkipVerify)
	assert.NotNil(t, cfg.RootCAs)
}

func TestARepoWithNeitherLeavesTheDefaultTrust(t *testing.T) {
	h := newHarness(t, aijob("train-1"))
	h.reconcile("train-1")
	require.Len(t, h.helm.ensured, 1)
	assert.Nil(t, h.helm.ensured[0].TLSConfig)
}
