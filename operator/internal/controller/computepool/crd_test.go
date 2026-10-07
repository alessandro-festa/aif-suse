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
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/envtest"

	"github.com/SUSE/aif-operator/api/v1alpha1"
)

// TestCRDRules runs the generated ComputePool CRD in a real API server: the
// cluster a pool is on cannot change and is never Rancher's local cluster, and
// kind is gpu or cpu. Skipped when the
// envtest binaries are not installed (make setup-envtest).
func TestCRDRules(t *testing.T) {
	assets := os.Getenv("KUBEBUILDER_ASSETS")
	if assets == "" {
		if entries, err := os.ReadDir(filepath.Join("..", "..", "..", "bin", "k8s")); err == nil {
			for _, e := range entries {
				if e.IsDir() {
					assets = filepath.Join("..", "..", "..", "bin", "k8s", e.Name())
				}
			}
		}
	}
	if assets == "" {
		t.Skip("envtest binaries not found; run make setup-envtest")
	}
	env := &envtest.Environment{
		CRDDirectoryPaths:     []string{filepath.Join("..", "..", "..", "config", "crd", "bases")},
		ErrorIfCRDPathMissing: true,
		BinaryAssetsDirectory: assets,
	}
	cfg, err := env.Start()
	require.NoError(t, err)
	t.Cleanup(func() { _ = env.Stop() })

	s := runtime.NewScheme()
	require.NoError(t, clientgoscheme.AddToScheme(s))
	require.NoError(t, v1alpha1.AddToScheme(s))
	c, err := client.New(cfg, client.Options{Scheme: s})
	require.NoError(t, err)
	ctx := context.Background()

	p := &v1alpha1.ComputePool{
		ObjectMeta: metav1.ObjectMeta{Name: "c-abc-cpu"},
		Spec:       v1alpha1.ComputePoolSpec{ClusterID: "c-abc", Kind: v1alpha1.ComputePoolKindCPU},
	}
	require.NoError(t, c.Create(ctx, p))

	p.Spec.ClusterID = "c-other"
	err = c.Update(ctx, p)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "spec.clusterId is immutable")

	cur := &v1alpha1.ComputePool{}
	require.NoError(t, c.Get(ctx, client.ObjectKeyFromObject(p), cur))
	cur.Spec.Disabled = true
	require.NoError(t, c.Update(ctx, cur), "everything else about a pool can change")

	require.NoError(t, c.Get(ctx, client.ObjectKeyFromObject(p), cur))
	cur.Spec.Reclaim = &v1alpha1.ComputePoolReclaim{IdleTimeout: "2h", MaxIdleTimeout: "3d"}
	require.NoError(t, c.Update(ctx, cur), "an admin turns reclaim on")
	assert.Equal(t, int32(5), cur.Spec.Reclaim.IdleThreshold, "the idle threshold defaults to 5%")
	for _, bad := range []v1alpha1.ComputePoolReclaim{{IdleTimeout: "90"}, {IdleTimeout: "1w"}, {IdleTimeout: "2h", IdleThreshold: 101}, {}} {
		require.NoError(t, c.Get(ctx, client.ObjectKeyFromObject(p), cur))
		cur.Spec.Reclaim = &bad
		assert.Error(t, c.Update(ctx, cur), "%+v", bad)
	}

	bad := &v1alpha1.ComputePool{
		ObjectMeta: metav1.ObjectMeta{Name: "bad"},
		Spec:       v1alpha1.ComputePoolSpec{ClusterID: "c-abc", Kind: "tpu"},
	}
	assert.Error(t, c.Create(ctx, bad), "kind is gpu or cpu")
	bad.Spec.Kind, bad.Spec.ClusterID = v1alpha1.ComputePoolKindCPU, "local"
	err = c.Create(ctx, bad)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "local cluster has no compute pools")
	bad.Spec.Kind, bad.Spec.ClusterID = v1alpha1.ComputePoolKindGPU, ""
	assert.Error(t, c.Create(ctx, bad), "clusterId is required")
}
