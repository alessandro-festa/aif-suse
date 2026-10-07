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
	_ "embed"
)

// Name is the chart's name, as its Chart.yaml gives it.
const Name = "gpu-train-job"

//go:embed gpu-train-job.tgz
var archive []byte

// Archive returns the packaged chart.
func Archive() []byte { return archive }
