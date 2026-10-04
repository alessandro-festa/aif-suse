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
	"fmt"
	"net/http"

	aiplatformv1alpha1 "github.com/SUSE/aif-operator/api/v1alpha1"
	"k8s.io/apimachinery/pkg/api/errors"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

// AIJobHandler serves the AIJob records the Workloads page lists: list,
// cancel and delete. Creating an AIJob is a separate change.
type AIJobHandler struct {
	client client.Client
}

// NewAIJobHandler constructs an AIJobHandler.
func NewAIJobHandler(c client.Client) *AIJobHandler {
	return &AIJobHandler{client: c}
}

// Register wires the handler's routes onto the mux.
func (h *AIJobHandler) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/aijobs", h.listAIJobs)
	mux.HandleFunc("POST /api/v1/namespaces/{namespace}/aijobs/{name}/cancel", h.cancelAIJob)
	mux.HandleFunc("DELETE /api/v1/namespaces/{namespace}/aijobs/{name}", h.deleteAIJob)
}

func (h *AIJobHandler) listAIJobs(w http.ResponseWriter, r *http.Request) {
	var list aiplatformv1alpha1.AIJobList
	if err := h.client.List(r.Context(), &list); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	for i := range list.Items {
		list.Items[i].ManagedFields = nil
		// The client strips TypeMeta from list items; restore it so consumers
		// (the UI's YAML view) get a self-describing object.
		list.Items[i].APIVersion = aiplatformv1alpha1.GroupVersion.String()
		list.Items[i].Kind = "AIJob"
	}
	writeJSON(w, http.StatusOK, &list)
}

// cancelAIJob sets spec.cancel. The controller uninstalls the release and the
// job ends Cancelled; a job that already finished is left as it is.
func (h *AIJobHandler) cancelAIJob(w http.ResponseWriter, r *http.Request) {
	namespace, name := r.PathValue("namespace"), r.PathValue("name")
	job := &aiplatformv1alpha1.AIJob{}
	if err := h.client.Get(r.Context(), client.ObjectKey{Namespace: namespace, Name: name}, job); err != nil {
		if errors.IsNotFound(err) {
			writeError(w, http.StatusNotFound, fmt.Errorf("%w: job %q not found in namespace %q", ErrNotFound, name, namespace))
			return
		}
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	if job.Status.Phase.IsTerminal() {
		writeError(w, http.StatusConflict, fmt.Errorf("%w: job %q has already finished (%s)", ErrConflict, name, job.Status.Phase))
		return
	}
	if job.Spec.Cancel {
		writeJSON(w, http.StatusOK, map[string]string{"status": "cancelling"})
		return
	}
	patch := client.MergeFrom(job.DeepCopy())
	job.Spec.Cancel = true
	if err := h.client.Patch(r.Context(), job, patch); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "cancelling"})
}

// deleteAIJob deletes the record. The controller's finalizer uninstalls the
// release first, so deleting a job also removes what it is running.
func (h *AIJobHandler) deleteAIJob(w http.ResponseWriter, r *http.Request) {
	job := &aiplatformv1alpha1.AIJob{}
	job.Name, job.Namespace = r.PathValue("name"), r.PathValue("namespace")
	if err := h.client.Delete(r.Context(), job); err != nil {
		if errors.IsNotFound(err) {
			writeError(w, http.StatusNotFound, fmt.Errorf("%w: job %q not found in namespace %q", ErrNotFound, job.Name, job.Namespace))
			return
		}
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Compile-time guard.
var _ Handler = (*AIJobHandler)(nil)
