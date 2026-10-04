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

package aiworkload

import (
	"context"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	kruntime "k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	aiplatformv1alpha1 "github.com/SUSE/aif-operator/api/v1alpha1"
)

// A ClusterRepo the admin marked insecureSkipTLSVerify (a self-signed or mirror registry) must
// produce a HelmOp that Fleet can pull from too; otherwise Fleet refuses the chart, the HelmOp is
// never Accepted, and the component sits in Pending while Rancher itself reads the repo fine.
func TestAHelmOpCarriesItsClusterRepoTLSVerificationSetting(t *testing.T) {
	scheme := kruntime.NewScheme()
	if err := aiplatformv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	scheme.AddKnownTypeWithName(clusterRepoGVK, &unstructured.Unstructured{})
	scheme.AddKnownTypeWithName(schema.GroupVersionKind{Group: "catalog.cattle.io", Version: "v1", Kind: "ClusterRepoList"}, &unstructured.UnstructuredList{})

	repo := func(name string, insecure bool) *unstructured.Unstructured {
		u := &unstructured.Unstructured{}
		u.SetGroupVersionKind(clusterRepoGVK)
		u.SetName(name)
		_ = unstructured.SetNestedField(u.Object, "oci://registry.example.com/charts", "spec", "url")
		if insecure {
			_ = unstructured.SetNestedField(u.Object, true, "spec", "insecureSkipTLSVerify")
		}
		return u
	}
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(repo("mirror", true), repo("public", false)).Build()
	r := &AIWorkloadReconciler{Client: c, Scheme: scheme}

	for name, want := range map[string]bool{"mirror": true, "public": false} {
		info, err := r.resolveClusterRepo(context.Background(), name)
		if err != nil {
			t.Fatalf("resolveClusterRepo(%s): %v", name, err)
		}
		if info.InsecureSkipTLSVerify != want {
			t.Errorf("%s: InsecureSkipTLSVerify = %v, want %v", name, info.InsecureSkipTLSVerify, want)
		}
		ho := &unstructured.Unstructured{Object: map[string]any{}}
		applyRepoTLS(ho, info)
		got, found, _ := unstructured.NestedBool(ho.Object, "spec", "insecureSkipTLSVerify")
		if got != want || (!want && found) {
			t.Errorf("%s: HelmOp spec.insecureSkipTLSVerify = %v (set: %v), want %v and unset when false", name, got, found, want)
		}
	}
}
