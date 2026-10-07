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

package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	aiplatformv1alpha1 "github.com/SUSE/aif-operator/api/v1alpha1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	kruntime "k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
)

func newAIJobHandler(t *testing.T, objs ...client.Object) (http.Handler, client.Client) {
	t.Helper()
	s := kruntime.NewScheme()
	if err := aiplatformv1alpha1.AddToScheme(s); err != nil {
		t.Fatal(err)
	}
	c := fake.NewClientBuilder().
		WithScheme(s).
		WithStatusSubresource(&aiplatformv1alpha1.AIJob{}).
		WithObjects(objs...).
		Build()
	mux := http.NewServeMux()
	NewAIJobHandler(c).Register(mux)
	return mux, c
}

func aiJob(name string, phase aiplatformv1alpha1.AIJobPhase) *aiplatformv1alpha1.AIJob {
	return &aiplatformv1alpha1.AIJob{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "team-a"},
		Spec: aiplatformv1alpha1.AIJobSpec{
			Category: aiplatformv1alpha1.WorkloadCategory("training"),
			Source:   &aiplatformv1alpha1.AIJobSource{RepoName: "training", ChartName: "train-job", Version: "1.0.0"},
		},
		Status: aiplatformv1alpha1.AIJobStatus{Phase: phase},
	}
}

func TestListAIJobs_ItemsCarryTypeMeta(t *testing.T) {
	h, _ := newAIJobHandler(t, aiJob("train-1", aiplatformv1alpha1.AIJobPhaseRunning))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("GET", "/api/v1/aijobs", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var list struct {
		Items []struct {
			APIVersion string `json:"apiVersion"`
			Kind       string `json:"kind"`
			Metadata   struct {
				Name          string `json:"name"`
				ManagedFields []any  `json:"managedFields"`
			} `json:"metadata"`
		} `json:"items"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &list); err != nil {
		t.Fatal(err)
	}
	if len(list.Items) != 1 || list.Items[0].Metadata.Name != "train-1" {
		t.Fatalf("expected train-1, got %+v", list.Items)
	}
	if list.Items[0].Kind != "AIJob" || list.Items[0].APIVersion != aiplatformv1alpha1.GroupVersion.String() {
		t.Errorf("type meta = %q %q", list.Items[0].APIVersion, list.Items[0].Kind)
	}
	if list.Items[0].Metadata.ManagedFields != nil {
		t.Error("managedFields should be stripped")
	}
}

func TestCancelAIJob_SetsCancel(t *testing.T) {
	h, c := newAIJobHandler(t, aiJob("train-1", aiplatformv1alpha1.AIJobPhaseQueued))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("POST", "/api/v1/namespaces/team-a/aijobs/train-1/cancel", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	got := &aiplatformv1alpha1.AIJob{}
	if err := c.Get(context.Background(), client.ObjectKey{Namespace: "team-a", Name: "train-1"}, got); err != nil {
		t.Fatal(err)
	}
	if !got.Spec.Cancel {
		t.Error("spec.cancel was not set")
	}
}

func TestCancelAIJob_FinishedJobIsAConflict(t *testing.T) {
	h, _ := newAIJobHandler(t, aiJob("train-1", aiplatformv1alpha1.AIJobPhaseSucceeded))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("POST", "/api/v1/namespaces/team-a/aijobs/train-1/cancel", nil))
	if w.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d: %s", w.Code, w.Body.String())
	}
}

func TestCancelAIJob_NotFound(t *testing.T) {
	h, _ := newAIJobHandler(t)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("POST", "/api/v1/namespaces/team-a/aijobs/missing/cancel", nil))
	if w.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", w.Code, w.Body.String())
	}
}

func TestDeleteAIJob(t *testing.T) {
	h, c := newAIJobHandler(t, aiJob("train-1", aiplatformv1alpha1.AIJobPhaseFailed))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("DELETE", "/api/v1/namespaces/team-a/aijobs/train-1", nil))
	if w.Code != http.StatusNoContent {
		t.Fatalf("expected 204, got %d: %s", w.Code, w.Body.String())
	}
	if err := c.Get(context.Background(), client.ObjectKey{Namespace: "team-a", Name: "train-1"}, &aiplatformv1alpha1.AIJob{}); err == nil {
		t.Error("job still exists")
	}

	w = httptest.NewRecorder()
	h.ServeHTTP(w, httptest.NewRequest("DELETE", "/api/v1/namespaces/team-a/aijobs/train-1", nil))
	if w.Code != http.StatusNotFound {
		t.Fatalf("second delete: expected 404, got %d", w.Code)
	}
}
