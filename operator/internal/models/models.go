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

// Package models owns the "Models" catalog served to the AIF UI: validated vLLM
// inference recipes (from recipes.vllm.ai), normalized to the flat browse shape the
// Models page renders and the deploy wizard translates into AppCo vLLM helm values.
//
// The bundled default list is embedded here (a curated NVIDIA, vLLM-deployable
// subset). A remote recipes source can be normalized through the same code path in a
// later iteration; the endpoint always falls back to this bundled list.
package models

import (
	_ "embed"
	"encoding/json"
	"sort"
	"strings"
)

//go:embed default-models.json
var bundledJSON []byte

// Entry is a single Models catalog entry. Its JSON tags mirror the UI's
// ModelCatalogEntry (ui/pkg/aif-ui/types/model-catalog.ts) exactly.
type Entry struct {
	ID                 string   `json:"id"`
	Title              string   `json:"title"`
	Provider           string   `json:"provider"`
	Description        string   `json:"description,omitempty"`
	Architecture       string   `json:"architecture"`
	ParameterCount     string   `json:"parameterCount"`
	ActiveParameters   string   `json:"activeParameters,omitempty"`
	ContextLength      int      `json:"contextLength"`
	Precisions         []string `json:"precisions"`
	GpuVendor          string   `json:"gpuVendor"`
	GpuFamilies        []string `json:"gpuFamilies"`
	// VerifiedFamilies is the subset of GpuFamilies actually vLLM-community-verified
	// (from meta.hardware == "verified"); may be empty (e.g. Trinity-Large-Thinking).
	VerifiedFamilies   []string `json:"verifiedFamilies,omitempty"`
	Tasks              []string `json:"tasks"`
	MinVllmVersion     string   `json:"minVllmVersion,omitempty"`
	RecipeURL          string   `json:"recipeUrl,omitempty"`
	SizeBucket         string   `json:"sizeBucket"`
	// Author-validated recommended hardware profile (from the recipe's
	// recommended_command.hardware_profile on recipes.vllm.ai).
	RecHardware        string   `json:"recHardware,omitempty"`
	RecGpuCount        int      `json:"recGpuCount,omitempty"`
	RecVramGB          int      `json:"recVramGB,omitempty"`
	LogoURL            string   `json:"logoUrl,omitempty"`
	CommunityValidated bool     `json:"communityValidated,omitempty"`
	Free               bool     `json:"free,omitempty"`

	// ByHardware maps each verified hardware key (e.g. "h200") to the per-hardware
	// recipe JSON path. Kept in-memory only (not served) to lazily resolve the full
	// list of verified configurations for the detail page.
	ByHardware map[string]string `json:"-"`
}

// HardwareConfig is one vLLM-community-verified hardware configuration for a model.
type HardwareConfig struct {
	Hardware     string `json:"hardware"`
	GpuCount     int    `json:"gpuCount"`
	VramPerGpuGB int    `json:"vramPerGpuGB"`
	TotalVramGB  int    `json:"totalVramGB"`
}

// bundled is normalized once at startup from the embedded default list.
var bundled = Normalize(bundledJSON)

// Bundled returns the normalized default Models catalog shipped with the operator.
func Bundled() []Entry { return bundled }

// Normalize turns a raw models document (a flat array or a {"items":[...]} wrapper)
// into a validated, sorted []Entry. Entries missing an id or title are dropped;
// results are sorted by provider then title. Returns nil when nothing valid is found.
func Normalize(raw []byte) []Entry {
	entries := parse(raw)
	out := make([]Entry, 0, len(entries))
	for _, e := range entries {
		if e.ID == "" || e.Title == "" {
			continue
		}
		out = append(out, e)
	}
	sort.SliceStable(out, func(i, j int) bool {
		pi, pj := strings.ToLower(out[i].Provider), strings.ToLower(out[j].Provider)
		if pi != pj {
			return pi < pj
		}
		return strings.ToLower(out[i].Title) < strings.ToLower(out[j].Title)
	})
	if len(out) == 0 {
		return nil
	}
	return out
}

func parse(raw []byte) []Entry {
	var arr []Entry
	if err := json.Unmarshal(raw, &arr); err == nil {
		return arr
	}
	var obj struct {
		Items []Entry `json:"items"`
	}
	if err := json.Unmarshal(raw, &obj); err == nil {
		return obj.Items
	}
	return nil
}
