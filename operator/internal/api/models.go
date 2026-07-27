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
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/SUSE/aif-operator/internal/models"
)

// modelsRefreshInterval is how often the live recipes.vllm.ai catalog is re-fetched.
const modelsRefreshInterval = 6 * time.Hour

// ModelsHandler serves GET /api/v1/models: the "Models" catalog (validated vLLM
// recipes from recipes.vllm.ai) the AIF UI renders and the deploy wizard translates
// into AppCo vLLM helm values. The full catalog is fetched and normalized in the
// background and cached; until the first successful fetch (or if fetching fails) the
// operator's bundled default list is served. The data model is vendor-generic; the UI
// restricts the browse to NVIDIA by default.
type ModelsHandler struct {
	mu   sync.RWMutex
	live []models.Entry
}

// NewModelsHandler constructs a ModelsHandler and starts its background refresher.
func NewModelsHandler() *ModelsHandler {
	h := &ModelsHandler{}
	go h.refreshLoop()
	return h
}

func (h *ModelsHandler) refreshLoop() {
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
		entries, err := models.FetchRecipes(ctx)
		cancel()
		switch {
		case err != nil:
			log.Printf("api: models: recipe fetch failed (%v); serving bundled (%d) until next refresh", err, len(models.Bundled()))
		case len(entries) == 0:
			log.Printf("api: models: recipe fetch returned no entries; serving bundled (%d)", len(models.Bundled()))
		default:
			h.mu.Lock()
			h.live = entries
			h.mu.Unlock()
			log.Printf("api: models: cached %d live recipes from recipes.vllm.ai", len(entries))
		}
		time.Sleep(modelsRefreshInterval)
	}
}

// Register wires the handler's routes onto the mux.
func (h *ModelsHandler) Register(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/v1/models", h.list)
	mux.HandleFunc("GET /api/v1/models/configs", h.configs)
}

func (h *ModelsHandler) list(w http.ResponseWriter, _ *http.Request) {
	h.mu.RLock()
	live := h.live
	h.mu.RUnlock()
	if len(live) > 0 {
		writeJSON(w, http.StatusOK, live)
		return
	}
	writeJSON(w, http.StatusOK, models.Bundled())
}

// configs returns the full list of vLLM-community-verified hardware configurations
// for one model (GET /api/v1/models/configs?id=<hf_id>), resolved on demand from the
// per-hardware recipes.
func (h *ModelsHandler) configs(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if id == "" {
		writeJSON(w, http.StatusOK, []models.HardwareConfig{})
		return
	}
	h.mu.RLock()
	live := h.live
	h.mu.RUnlock()

	var byHW map[string]string
	for i := range live {
		if live[i].ID == id {
			byHW = live[i].ByHardware
			break
		}
	}
	if len(byHW) == 0 {
		writeJSON(w, http.StatusOK, []models.HardwareConfig{})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	writeJSON(w, http.StatusOK, models.FetchHardwareConfigs(ctx, byHW))
}

var _ Handler = (*ModelsHandler)(nil)
