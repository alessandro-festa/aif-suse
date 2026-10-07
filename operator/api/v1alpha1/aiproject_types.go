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

package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// AIProjectRole is what a member may do in an AI project.
// +kubebuilder:validation:Enum=owner;member;read-only
type AIProjectRole string

const (
	// AIProjectRoleOwner runs jobs and manages the project's members.
	AIProjectRoleOwner AIProjectRole = "owner"
	// AIProjectRoleMember runs jobs.
	AIProjectRoleMember AIProjectRole = "member"
	// AIProjectRoleReadOnly sees the project's jobs.
	AIProjectRoleReadOnly AIProjectRole = "read-only"
)

// AIProjectSubject is a Rancher user or group.
type AIProjectSubject struct {
	// Kind is User (a Rancher user ID, e.g. "user-2khzq") or Group (a group
	// principal, e.g. "github_team://42").
	// +kubebuilder:validation:Enum=User;Group
	Kind string `json:"kind"`
	// +kubebuilder:validation:MinLength=1
	Name string `json:"name"`
}

// AIProjectCluster is one cluster an AI project runs work on.
type AIProjectCluster struct {
	// ClusterID is the Rancher cluster ID of a downstream cluster.
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:XValidation:rule="self != 'local'",message="Rancher's local cluster runs no AI work"
	ClusterID string `json:"clusterId"`
	// Namespace is the project's namespace there, where its jobs run. Created in
	// the project's Rancher project when missing.
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=63
	Namespace string `json:"namespace"`
	// ProjectID adopts an existing Rancher project on the cluster (e.g.
	// "p-abc12"). Empty: the operator creates one, named after the AI project.
	// +optional
	ProjectID string `json:"projectId,omitempty"`
}

// AIProjectSpec is set by AI Factory administrators: the object is
// cluster-scoped, so only they can write it. Members beyond the owners are in
// the project's AIProjectMembers, which its owners may edit.
type AIProjectSpec struct {
	// +optional
	DisplayName string `json:"displayName,omitempty"`
	// Clusters the project runs work on. A job is placed on a compute pool of one
	// of them.
	// +kubebuilder:validation:MinItems=1
	// +listType=map
	// +listMapKey=clusterId
	Clusters []AIProjectCluster `json:"clusters"`
	// Owners are always owners, whatever the members list says.
	// +kubebuilder:validation:MinItems=1
	Owners []AIProjectSubject `json:"owners"`
}

// AIProjectClusterStatus is what the operator set up on one cluster.
type AIProjectClusterStatus struct {
	ClusterID string `json:"clusterId"`
	// ProjectID is the Rancher project the namespace is in.
	// +optional
	ProjectID string `json:"projectId,omitempty"`
	// Namespace is the project's namespace on the cluster.
	// +optional
	Namespace string `json:"namespace,omitempty"`
	// Ready is true when the Rancher project, the namespace and the members'
	// role bindings are in place.
	Ready bool `json:"ready"`
	// +optional
	Message string `json:"message,omitempty"`
}

// AIProjectStatus says where the project's pieces are.
type AIProjectStatus struct {
	// Namespace is the project's namespace on local, where its AIJobs live.
	// +optional
	Namespace string `json:"namespace,omitempty"`
	// +optional
	Clusters []AIProjectClusterStatus `json:"clusters,omitempty"`
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:scope=Cluster,shortName=aiproj
// +kubebuilder:printcolumn:name="Display",type=string,JSONPath=`.spec.displayName`
// +kubebuilder:printcolumn:name="Namespace",type=string,JSONPath=`.status.namespace`
// +kubebuilder:printcolumn:name="Ready",type=string,JSONPath=`.status.conditions[?(@.type=="Ready")].status`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`

// AIProject is a team's AI work across clusters: who is in it, and the clusters
// and namespaces its training runs on. The operator keeps a namespace on local
// for its AIJobs (aif-<name>), and on every cluster it spans a Rancher project,
// a namespace, and Rancher role bindings for its members, so they reach their
// runs everywhere through Rancher.
type AIProject struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`
	Spec              AIProjectSpec `json:"spec"`
	// +optional
	Status AIProjectStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true

// AIProjectList contains a list of AIProject.
type AIProjectList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []AIProject `json:"items"`
}

// AIProjectMember is one member and their role.
type AIProjectMember struct {
	AIProjectSubject `json:",inline"`
	Role             AIProjectRole `json:"role"`
}

// AIProjectMembersSpec lists a project's members besides its owners.
type AIProjectMembersSpec struct {
	// +optional
	Members []AIProjectMember `json:"members,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:resource:shortName=aiprojmembers
// +kubebuilder:validation:XValidation:rule="self.metadata.name == 'members'",message="an AI project's members object is named members"

// AIProjectMembers holds the members of the AI project whose namespace on local
// it is in (aif-<project>), one object named "members". The project's owners
// may edit it; the operator gives each member their role on every cluster the
// project spans.
type AIProjectMembers struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`
	Spec              AIProjectMembersSpec `json:"spec,omitempty"`
}

// +kubebuilder:object:root=true

// AIProjectMembersList contains a list of AIProjectMembers.
type AIProjectMembersList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []AIProjectMembers `json:"items"`
}

func init() {
	SchemeBuilder.Register(&AIProject{}, &AIProjectList{}, &AIProjectMembers{}, &AIProjectMembersList{})
}
