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

package placement

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
	"sync"

	"helm.sh/helm/v3/pkg/chart"
	"helm.sh/helm/v3/pkg/chart/loader"
	"helm.sh/helm/v3/pkg/chartutil"
	"k8s.io/apimachinery/pkg/api/resource"

	"github.com/SUSE/aif-operator/internal/trainchart"
)

// Needs is what a training run asks of a pool, read from its chart values.
type Needs struct {
	Nodes       int64
	GPUsPerNode int64
	// Model is the GPU product the run is pinned to (gpu.productName), as the
	// node label spells it; "" = any.
	Model string
	// ShareMiB is a GPU-memory share (part of one GPU per pod); 0 = whole GPUs.
	ShareMiB int64
	CPU      resource.Quantity // the whole run's
	Memory   resource.Quantity // the whole run's
}

// GPUs is how many whole GPUs the run takes; a share takes none whole.
func (n Needs) GPUs() int64 {
	if n.ShareMiB > 0 {
		return 0
	}
	return n.Nodes * n.GPUsPerNode
}

// WantsGPU says whether the run needs a GPU pool.
func (n Needs) WantsGPU() bool { return n.GPUsPerNode > 0 || n.ShareMiB > 0 }

var (
	chartOnce sync.Once
	defaults  *chart.Chart
	chartErr  error
)

// NeedsOf reads a run's needs from its values, filled in with the built-in
// chart's defaults, as the chart itself would render them.
func NeedsOf(raw []byte) (Needs, error) {
	chartOnce.Do(func() { defaults, chartErr = loader.LoadArchive(bytes.NewReader(trainchart.Archive())) })
	if chartErr != nil {
		return Needs{}, chartErr
	}
	user := map[string]interface{}{}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &user); err != nil {
			return Needs{}, fmt.Errorf("spec.values: %w", err)
		}
	}
	v, err := chartutil.CoalesceValues(defaults, user)
	if err != nil {
		return Needs{}, err
	}
	n := Needs{
		Nodes:       intAt(v, "job", "nodes"),
		GPUsPerNode: intAt(v, "job", "gpusPerNode"),
		Model:       strings.ReplaceAll(strAt(v, "gpu", "productName"), " ", "-"),
		ShareMiB:    intAt(v, "gpu", "sharedMemoryMiB"),
	}
	if n.Nodes < 1 {
		n.Nodes = 1
	}
	if n.ShareMiB > 0 {
		n.GPUsPerNode = 1 // one fraction of one GPU per pod
	}
	for _, r := range []struct {
		key string
		dst *resource.Quantity
	}{{"cpu", &n.CPU}, {"memory", &n.Memory}} {
		s := strAt(v, "resources", "requests", r.key)
		if s == "" {
			continue
		}
		q, err := resource.ParseQuantity(s)
		if err != nil {
			return Needs{}, fmt.Errorf("resources.requests.%s: %w", r.key, err)
		}
		for i := int64(0); i < n.Nodes; i++ {
			r.dst.Add(q)
		}
	}
	return n, nil
}

func at(v map[string]interface{}, path ...string) interface{} {
	var cur interface{} = v
	for _, p := range path {
		m, ok := cur.(map[string]interface{})
		if !ok {
			return nil
		}
		cur = m[p]
	}
	return cur
}

func intAt(v map[string]interface{}, path ...string) int64 {
	switch x := at(v, path...).(type) {
	case float64:
		return int64(x)
	case int64:
		return x
	case int:
		return int64(x)
	case json.Number:
		i, _ := x.Int64()
		return i
	}
	return 0
}

func strAt(v map[string]interface{}, path ...string) string {
	switch x := at(v, path...).(type) {
	case string:
		return x
	case float64, int, int64:
		return fmt.Sprint(x)
	}
	return ""
}
