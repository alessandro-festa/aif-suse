package v1alpha1

import (
	"encoding/json"
	"strings"
	"testing"
)

// The category values are mirrored by the UI; a change here is a change
// to the CRD enum and to that list.
func TestWorkloadCategoryValues(t *testing.T) {
	got := []string{
		string(WorkloadCategoryInference), string(WorkloadCategoryTraining),
		string(WorkloadCategoryAgent), string(WorkloadCategoryRAG),
		string(WorkloadCategoryData), string(WorkloadCategoryCustom),
	}
	if want := "inference,training,agent,rag,data,custom"; strings.Join(got, ",") != want {
		t.Fatalf("category values = %q, want %q", strings.Join(got, ","), want)
	}
}

func TestCategoryJSONTagOmittedWhenUnset(t *testing.T) {
	b, err := json.Marshal(BlueprintSpec{DisplayName: "x", Version: "1.0.0"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "category") {
		t.Fatalf("unset category must be omitted, got %s", b)
	}
	b, err = json.Marshal(AIWorkloadSpec{DisplayName: "x", Category: WorkloadCategoryAgent})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), `"category":"agent"`) {
		t.Fatalf("category tag = %s", b)
	}
}
