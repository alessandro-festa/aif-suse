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

package models

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/SUSE/aif-operator/internal/infra/safehttp"
)

// recipesBase is the public recipes.vllm.ai source. The index (/models.json) lists
// every recipe; each entry's per-model JSON carries the hardware/arch/precision data
// we normalize into an Entry. The data model is vendor-generic; the UI restricts the
// browse to NVIDIA by default.
const recipesBase = "https://recipes.vllm.ai"

const (
	maxIndexBytes = 2 << 20  // 2 MiB
	maxDocBytes   = 512 << 10 // 512 KiB per recipe
	fetchWorkers  = 20
)

// recipesClient refuses internal/private destinations (SSRF defense).
var recipesClient = safehttp.NewClient(20 * time.Second)

type indexEntry struct {
	HFID        string `json:"hf_id"`
	Title       string `json:"title"`
	Provider    string `json:"provider"`
	URL         string `json:"url"`
	JSON        string `json:"json"`
	DerivedFrom string `json:"derived_from"`
}

type hwProfile struct {
	DisplayName string `json:"display_name"`
	GpuCount    int    `json:"gpu_count"`
	VramGB      int    `json:"vram_gb"`
}

type recipeDoc struct {
	HFID string `json:"hf_id"`
	Meta struct {
		Title       string            `json:"title"`
		Provider    string            `json:"provider"`
		Description string            `json:"description"`
		Tasks       []string          `json:"tasks"`
		Hardware    map[string]string `json:"hardware"` // hardware key -> status ("verified")
	} `json:"meta"`
	RecommendedCommand struct {
		ByHardware      map[string]json.RawMessage `json:"by_hardware"`
		HardwareProfile hwProfile                  `json:"hardware_profile"`
	} `json:"recommended_command"`
	// Per-hardware sub-recipes carry hardware_profile at the top level.
	HardwareProfile hwProfile `json:"hardware_profile"`
	Model struct {
		ModelID          string `json:"model_id"`
		Architecture     string `json:"architecture"`
		ParameterCount   string `json:"parameter_count"`
		ActiveParameters string `json:"active_parameters"`
		ContextLength    int    `json:"context_length"`
		MinVllmVersion   string `json:"min_vllm_version"`
	} `json:"model"`
	Variants map[string]struct {
		Precision string `json:"precision"`
	} `json:"variants"`
}

// gpuMap classifies a recipes.vllm.ai hardware key into (vendor, display family).
var gpuMap = map[string][2]string{
	"h100": {"nvidia", "H100"}, "h200": {"nvidia", "H200"}, "h20": {"nvidia", "H20"},
	"b200": {"nvidia", "B200"}, "b300": {"nvidia", "B300"},
	"gb200": {"nvidia", "GB200"}, "gb300": {"nvidia", "GB300"},
	"a100": {"nvidia", "A100"}, "a10": {"nvidia", "A10"}, "a10g": {"nvidia", "A10G"},
	"l40s": {"nvidia", "L40S"}, "l40": {"nvidia", "L40"}, "l4": {"nvidia", "L4"},
	"t4": {"nvidia", "T4"}, "v100": {"nvidia", "V100"},
	"mi300x": {"amd", "MI300X"}, "mi325x": {"amd", "MI325X"}, "mi355x": {"amd", "MI355X"}, "mi250": {"amd", "MI250"},
	"trillium": {"tpu", "Trillium"}, "v6e": {"tpu", "TPU v6e"}, "v5e": {"tpu", "TPU v5e"},
	"xeon6": {"cpu", "Xeon6"}, "xeon": {"cpu", "Xeon"},
}

var providerIcon = map[string]string{
	"qwen": "alibabadotcom", "alibaba": "alibabadotcom", "meta": "meta", "google": "google",
	"mistral": "mistralai", "deepseek": "deepseek", "nvidia": "nvidia", "amd": "amd",
}

// FetchRecipes fetches and normalizes the full recipes.vllm.ai catalog into []Entry.
// Per-model documents are fetched concurrently; entries whose hardware cannot be
// recognized are skipped. Results are sorted by provider then title.
func FetchRecipes(ctx context.Context) ([]Entry, error) {
	idx, err := fetchIndex(ctx)
	if err != nil {
		return nil, err
	}

	sem := make(chan struct{}, fetchWorkers)
	var wg sync.WaitGroup
	var mu sync.Mutex
	out := make([]Entry, 0, len(idx))

	for _, ie := range idx {
		if ie.JSON == "" {
			continue
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(ie indexEntry) {
			defer wg.Done()
			defer func() { <-sem }()
			doc, err := fetchDoc(ctx, ie.JSON)
			if err != nil {
				return
			}
			if e, ok := enrich(ie, doc); ok {
				mu.Lock()
				out = append(out, e)
				mu.Unlock()
			}
		}(ie)
	}
	wg.Wait()

	sort.SliceStable(out, func(i, j int) bool {
		pi, pj := strings.ToLower(out[i].Provider), strings.ToLower(out[j].Provider)
		if pi != pj {
			return pi < pj
		}
		return strings.ToLower(out[i].Title) < strings.ToLower(out[j].Title)
	})
	return out, nil
}

func fetchIndex(ctx context.Context) ([]indexEntry, error) {
	body, err := get(ctx, recipesBase+"/models.json", maxIndexBytes)
	if err != nil {
		return nil, err
	}
	var idx []indexEntry
	if err := json.Unmarshal(body, &idx); err != nil {
		return nil, fmt.Errorf("decode index: %w", err)
	}
	return idx, nil
}

func fetchDoc(ctx context.Context, path string) (recipeDoc, error) {
	var d recipeDoc
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	body, err := get(ctx, recipesBase+path, maxDocBytes)
	if err != nil {
		return d, err
	}
	if err := json.Unmarshal(body, &d); err != nil {
		return d, err
	}
	return d, nil
}

func get(ctx context.Context, url string, max int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	resp, err := recipesClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("unexpected status %s for %s", resp.Status, url)
	}
	return io.ReadAll(io.LimitReader(resp.Body, max))
}

func enrich(ie indexEntry, d recipeDoc) (Entry, bool) {
	// Filter to what our stack can actually deploy:
	//   (1) runnable on NVIDIA cards — at least one NVIDIA GPU family, and
	//   (2) servable by the AppCo vLLM chart — an LLM (its tasks include "text").
	// Everything else (AMD/TPU/CPU-only, or non-text: embedding/OCR/vision/audio) is dropped.
	var nv []string
	for k := range d.RecommendedCommand.ByHardware {
		if vendor, disp := classifyGPU(k); vendor == "nvidia" {
			nv = append(nv, disp)
		}
	}
	if len(nv) == 0 || !hasText(d.Meta.Tasks) {
		return Entry{}, false
	}
	fams := dedupSort(nv)

	id := firstNonEmpty(d.HFID, ie.HFID)
	if id == "" {
		return Entry{}, false
	}

	// meta.hardware maps a hardware key to its status; "verified" marks the
	// vLLM-community-verified hardware. by_hardware alone only means "a recipe
	// exists" (available), NOT verified — so we key verification off meta.hardware.
	verifiedSet := map[string]bool{}
	var verifiedFams []string
	for hw, status := range d.Meta.Hardware {
		if !strings.EqualFold(status, "verified") {
			continue
		}
		if vendor, disp := classifyGPU(hw); vendor == "nvidia" && !verifiedSet[disp] {
			verifiedSet[disp] = true
			verifiedFams = append(verifiedFams, disp)
		}
	}

	// Capture per-hardware recipe paths for the VERIFIED NVIDIA hardware only, so the
	// detail page's "verified configurations" list reflects real verification.
	byHW := map[string]string{}
	for k, v := range d.RecommendedCommand.ByHardware {
		vendor, disp := classifyGPU(k)
		if vendor != "nvidia" || !verifiedSet[disp] {
			continue
		}
		var p string
		if err := json.Unmarshal(v, &p); err == nil && p != "" {
			byHW[k] = p
		}
	}
	arch := "dense"
	if strings.EqualFold(d.Model.Architecture, "moe") {
		arch = "moe"
	}
	active := d.Model.ActiveParameters
	if active == d.Model.ParameterCount {
		active = ""
	}
	url := ie.URL
	if url == "" {
		url = "/" + id
	}

	return Entry{
		ID:                 id,
		Title:              firstNonEmpty(d.Meta.Title, ie.Title, id),
		Provider:           firstNonEmpty(d.Meta.Provider, ie.Provider),
		Description:        d.Meta.Description,
		Architecture:       arch,
		ParameterCount:     d.Model.ParameterCount,
		ActiveParameters:   active,
		ContextLength:      d.Model.ContextLength,
		Precisions:         collectPrecisions(d.Variants),
		GpuVendor:          "nvidia",
		GpuFamilies:        fams,
		Tasks:              d.Meta.Tasks,
		MinVllmVersion:     d.Model.MinVllmVersion,
		RecipeURL:          recipesBase + url,
		SizeBucket:         sizeBucket(d.Model.ParameterCount),
		RecHardware:        d.RecommendedCommand.HardwareProfile.DisplayName,
		RecGpuCount:        d.RecommendedCommand.HardwareProfile.GpuCount,
		RecVramGB:          d.RecommendedCommand.HardwareProfile.VramGB,
		LogoURL:            providerLogo(firstNonEmpty(d.Meta.Provider, ie.Provider)),
		CommunityValidated: true,
		Free:               true,
		VerifiedFamilies:   dedupSort(verifiedFams),
		ByHardware:         byHW,
	}, true
}

// FetchHardwareConfigs resolves the full list of NVIDIA verified configurations for a
// model by fetching each per-hardware recipe's hardware_profile (concurrently).
func FetchHardwareConfigs(ctx context.Context, byHardware map[string]string) []HardwareConfig {
	var wg sync.WaitGroup
	var mu sync.Mutex
	out := []HardwareConfig{}
	sem := make(chan struct{}, fetchWorkers)

	for hw, path := range byHardware {
		vendor, _ := classifyGPU(hw)
		if vendor != "nvidia" || path == "" {
			continue
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(path string) {
			defer wg.Done()
			defer func() { <-sem }()
			d, err := fetchDoc(ctx, path)
			if err != nil {
				return
			}
			// Sub-recipes carry hardware_profile at the top level; fall back to the
			// recommended_command one just in case.
			hp := d.HardwareProfile
			if hp.DisplayName == "" {
				hp = d.RecommendedCommand.HardwareProfile
			}
			if hp.DisplayName == "" || hp.GpuCount <= 0 {
				return
			}
			per := 0
			if hp.VramGB > 0 {
				per = hp.VramGB / hp.GpuCount
			}
			mu.Lock()
			out = append(out, HardwareConfig{Hardware: hp.DisplayName, GpuCount: hp.GpuCount, VramPerGpuGB: per, TotalVramGB: hp.VramGB})
			mu.Unlock()
		}(path)
	}
	wg.Wait()

	sort.SliceStable(out, func(i, j int) bool {
		if out[i].GpuCount != out[j].GpuCount {
			return out[i].GpuCount < out[j].GpuCount
		}
		return out[i].Hardware < out[j].Hardware
	})
	return out
}

func classifyGPU(k string) (string, string) {
	if v, ok := gpuMap[strings.ToLower(strings.TrimSpace(k))]; ok {
		return v[0], v[1]
	}
	return "", ""
}

func collectPrecisions(variants map[string]struct {
	Precision string `json:"precision"`
}) []string {
	seen := map[string]bool{}
	var out []string
	for _, v := range variants {
		p := strings.ToLower(strings.TrimSpace(v.Precision))
		if p != "" && !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	if len(out) == 0 {
		return []string{"bf16"}
	}
	sort.Strings(out)
	return out
}

func sizeBucket(pc string) string {
	n := parseLeadingFloat(pc)
	switch {
	case n <= 0:
		return "medium"
	case n < 8:
		return "small"
	case n < 35:
		return "medium"
	case n <= 100:
		return "large"
	default:
		return "xlarge"
	}
}

func parseLeadingFloat(s string) float64 {
	i := 0
	for i < len(s) && (s[i] >= '0' && s[i] <= '9' || s[i] == '.') {
		i++
	}
	if i == 0 {
		return 0
	}
	f, _ := strconv.ParseFloat(s[:i], 64)
	return f
}

func providerLogo(provider string) string {
	p := strings.ToLower(provider)
	for key, slug := range providerIcon {
		if strings.Contains(p, key) {
			return "https://cdn.simpleicons.org/" + slug
		}
	}
	return ""
}

func dedupSort(in []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(in))
	for _, v := range in {
		if !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	sort.Strings(out)
	return out
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// hasText reports whether a recipe's tasks mark it as a text LLM (vLLM-servable).
func hasText(tasks []string) bool {
	for _, t := range tasks {
		if strings.EqualFold(strings.TrimSpace(t), "text") {
			return true
		}
	}
	return false
}
