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
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	apixv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/envtest"

	"github.com/SUSE/aif-operator/api/v1alpha1"
)

// TestCRDRules runs the generated CRD in a real API server: the CEL rules that
// make source and values immutable and cancel one-way, and the retention
// default. Skipped when the envtest binaries are not installed
// (make setup-envtest).
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
	require.NoError(t, c.Create(ctx, &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns}}))

	j := &v1alpha1.AIJob{
		ObjectMeta: metav1.ObjectMeta{Name: "train-1", Namespace: ns},
		Spec: v1alpha1.AIJobSpec{
			Source: &v1alpha1.AIJobSource{RepoName: "gpu-train-charts", ChartName: "gpu-train-job", Version: "0.1.31"},
			Values: &apixv1.JSON{Raw: []byte(`{"job":{"nodes":2}}`)},
		},
	}
	require.NoError(t, c.Create(ctx, j))
	require.NotNil(t, j.Spec.Retention.ExecutionObjects, "retention defaults")
	assert.Equal(t, "168h0m0s", j.Spec.Retention.ExecutionObjects.Duration.String())

	update := func(mutate func(*v1alpha1.AIJob)) error {
		cur := &v1alpha1.AIJob{}
		require.NoError(t, c.Get(ctx, client.ObjectKeyFromObject(j), cur))
		mutate(cur)
		return c.Update(ctx, cur)
	}

	err = update(func(x *v1alpha1.AIJob) { x.Spec.Source.Version = "0.1.32" })
	require.Error(t, err)
	assert.Contains(t, err.Error(), "spec.source is immutable")

	err = update(func(x *v1alpha1.AIJob) { x.Spec.Source = nil })
	require.Error(t, err, "dropping the source would switch to the built-in chart")
	assert.Contains(t, err.Error(), "spec.source is immutable")

	err = update(func(x *v1alpha1.AIJob) { x.Spec.Values = &apixv1.JSON{Raw: []byte(`{"job":{"nodes":4}}`)} })
	require.Error(t, err)
	assert.Contains(t, err.Error(), "spec.values is immutable")

	err = update(func(x *v1alpha1.AIJob) { x.Spec.Values = nil })
	require.Error(t, err, "removing values is a change too")

	// Informational fields and retention may change.
	require.NoError(t, update(func(x *v1alpha1.AIJob) {
		x.Spec.DisplayName = "renamed"
		x.Spec.Retention.ExecutionObjects = &metav1.Duration{Duration: 720 * 3600 * 1e9}
	}))

	require.NoError(t, update(func(x *v1alpha1.AIJob) { x.Spec.Cancel = true }))
	err = update(func(x *v1alpha1.AIJob) { x.Spec.Cancel = false })
	require.Error(t, err)
	assert.Contains(t, err.Error(), "spec.cancel cannot be undone")

	bad := j.DeepCopy()
	bad.ResourceVersion, bad.Name = "", "bad"
	bad.Spec.Source.ChartName = ""
	assert.Error(t, c.Create(ctx, bad), "chartName is required")

	builtIn := &v1alpha1.AIJob{ObjectMeta: metav1.ObjectMeta{Name: "built-in", Namespace: ns}}
	require.NoError(t, c.Create(ctx, builtIn), "a job without a source installs the built-in chart")
	cur := &v1alpha1.AIJob{}
	require.NoError(t, c.Get(ctx, client.ObjectKeyFromObject(builtIn), cur))
	cur.Spec.Source = &v1alpha1.AIJobSource{RepoName: "r", ChartName: "c", Version: "1"}
	err = c.Update(ctx, cur)
	require.Error(t, err, "a source cannot be added later either")
	assert.Contains(t, err.Error(), "spec.source is immutable")
}
