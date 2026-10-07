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

// Package trainchart is the training chart (charts/gpu-train-job) built into the
// operator. An AIJob with no spec.source installs it, so a cluster needs no chart
// repository to run a training job, air-gapped ones included.
//
// The archive is generated: run `make train-chart` after changing the chart. The
// operator image is built from operator/ alone, so the chart cannot be embedded
// from its source directory; TestArchiveMatchesChartSource catches a stale copy.
package trainchart

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	_ "embed"
	"fmt"
	"io"
	"sync"

	"sigs.k8s.io/yaml"
)

// Name is the chart's name, as its Chart.yaml gives it.
const Name = "gpu-train-job"

//go:embed gpu-train-job.tgz
var archive []byte

// Archive returns the packaged chart.
func Archive() []byte { return archive }

// Backend is one scheduler backend from the chart's schedulers.yaml: how a run is
// bound to it. See that file for what each field means.
type Backend struct {
	Display       string        `json:"display"`
	Detect        *BackendProbe `json:"detect"`
	SchedulerName string        `json:"schedulerName"`
	Queue         *BackendQueue `json:"queue"`
	Admission     string        `json:"admission"`
	Gang          string        `json:"gang"`
	Quota         string        `json:"quota"`
	Sharing       []string      `json:"sharing"`
	// SharingWith are the sharing layers (SharingLayers) a run under it may use.
	SharingWith []string `json:"sharingWith"`
}

// SharingLayer is a GPU-sharing layer a run can use beside its scheduler (HAMi).
type SharingLayer struct {
	Display string `json:"display"`
	Detect  struct {
		// NodeAnnotation is the layer's device registration on a node.
		NodeAnnotation string `json:"nodeAnnotation"`
		// Image, when set, must be in a running pod's image too.
		Image string `json:"image,omitempty"`
	} `json:"detect"`
	SchedulerName string `json:"schedulerName"`
	Resources     struct {
		GPU    string `json:"gpu"`
		Memory string `json:"memory"`
		Cores  string `json:"cores"`
	} `json:"resources"`
}

// BackendProbe says the backend is installed when the cluster serves Group and
// does not serve Unless.
type BackendProbe struct {
	Group  string `json:"group"`
	Unless string `json:"unless,omitempty"`
	// Image, when set, must be in a running pod's image too: CRDs outlive an uninstall.
	Image string `json:"image,omitempty"`
}

// BackendQueue is how a run names its queue: a Label on the pods ("pod") or on
// the Job / PyTorchJob ("workload"). As "annotation" makes Label a pod
// annotation key; Default is the queue of a run that names none.
type BackendQueue struct {
	Target         string `json:"target"`
	Label          string `json:"label"`
	As             string `json:"as,omitempty"`
	Default        string `json:"default,omitempty"`
	NamespaceLabel string `json:"namespaceLabel,omitempty"`
}

// table is schedulers.yaml.
type table struct {
	Backends      map[string]Backend      `json:"backends"`
	SharingLayers map[string]SharingLayer `json:"sharingLayers"`
}

var (
	tableOnce sync.Once
	theTable  table
	tableErr  error
)

func readOnce() (table, error) {
	tableOnce.Do(func() { theTable, tableErr = readTable(archive) })
	return theTable, tableErr
}

// Backends returns the scheduler backends the built-in chart knows, by
// scheduler.type.
func Backends() (map[string]Backend, error) {
	t, err := readOnce()
	return t.Backends, err
}

// SharingLayers returns the GPU-sharing layers the built-in chart knows, by
// gpu.sharing.
func SharingLayers() (map[string]SharingLayer, error) {
	t, err := readOnce()
	return t.SharingLayers, err
}

func readTable(tgz []byte) (table, error) {
	gz, err := gzip.NewReader(bytes.NewReader(tgz))
	if err != nil {
		return table{}, err
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return table{}, fmt.Errorf("%s/schedulers.yaml not in the chart", Name)
		}
		if err != nil {
			return table{}, err
		}
		if h.Name != Name+"/schedulers.yaml" {
			continue
		}
		b, err := io.ReadAll(tr)
		if err != nil {
			return table{}, err
		}
		var doc table
		if err := yaml.UnmarshalStrict(b, &doc); err != nil {
			return table{}, fmt.Errorf("schedulers.yaml: %w", err)
		}
		return doc, nil
	}
}
