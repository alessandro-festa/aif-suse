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

package trainchart

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"helm.sh/helm/v3/pkg/chart/loader"
)

const chartSource = "../../../charts/gpu-train-job"

func TestArchiveIsTheTrainingChart(t *testing.T) {
	ch, err := loader.LoadArchive(bytes.NewReader(Archive()))
	if err != nil {
		t.Fatalf("embedded archive does not load: %v", err)
	}
	if ch.Metadata.Name != Name {
		t.Fatalf("embedded chart is %q, want %q", ch.Metadata.Name, Name)
	}
}

// The embedded archive is a generated copy of charts/gpu-train-job. A chart change
// without `make train-chart` would ship the old chart to every AIJob, silently.
func TestArchiveMatchesChartSource(t *testing.T) {
	if _, err := os.Stat(chartSource); errors.Is(err, fs.ErrNotExist) {
		t.Skip("chart source not present (operator built outside the repository)")
	}

	packaged := map[string][]byte{}
	gz, err := gzip.NewReader(bytes.NewReader(Archive()))
	if err != nil {
		t.Fatal(err)
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		b, err := io.ReadAll(tr)
		if err != nil {
			t.Fatal(err)
		}
		packaged[strings.TrimPrefix(h.Name, Name+"/")] = b
	}

	ignored := map[string]bool{}
	if b, err := os.ReadFile(filepath.Join(chartSource, ".helmignore")); err == nil {
		for _, l := range strings.Split(string(b), "\n") {
			if l = strings.TrimSpace(l); l != "" && !strings.HasPrefix(l, "#") {
				ignored[l] = true
			}
		}
	}

	stale := "embedded training chart is stale: run `make train-chart`"

	// helm package rewrites Chart.yaml, so it is compared as the metadata it parses to.
	src, err := loader.Load(chartSource)
	if err != nil {
		t.Fatal(err)
	}
	emb, err := loader.LoadArchive(bytes.NewReader(Archive()))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(src.Metadata, emb.Metadata) {
		t.Errorf("%s: Chart.yaml differs", stale)
	}
	delete(packaged, "Chart.yaml")
	err = filepath.WalkDir(chartSource, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(chartSource, p)
		rel = filepath.ToSlash(rel)
		if rel == "Chart.yaml" {
			return nil
		}
		got, ok := packaged[rel]
		if !ok {
			if !ignored[rel] {
				t.Errorf("%s: %s missing from the archive", stale, rel)
			}
			return nil
		}
		want, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		if !bytes.Equal(got, want) {
			t.Errorf("%s: %s differs", stale, rel)
		}
		delete(packaged, rel)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for rel := range packaged {
		t.Errorf("%s: %s is in the archive but not in the chart", stale, rel)
	}
}
