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

// Package aiproject keeps every AIProject in place: its namespace on the
// management cluster (aif-<project>), where its AIJobs live, with RoleBindings
// for its members; and on every cluster it spans a Rancher project, the
// project's namespace and Rancher role bindings for its members, so they reach
// their runs there through Rancher. Rancher objects are written through Rancher
// with the Settings token: as the administrator who authorized it, so Rancher's
// own checks on who may grant what apply.
package aiproject

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"sort"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	controllerruntime "sigs.k8s.io/controller-runtime"
	ctrl "sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	"sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	"github.com/SUSE/aif-operator/api/v1alpha1"
)

const (
	// ProjectLabel names the AIProject an object belongs to: its namespace on
	// local, and the Rancher projects and role bindings made for it.
	ProjectLabel = "ai-factory.suse.com/aiproject"
	// MembersName is the AIProjectMembers object in a project's namespace.
	MembersName = "members"

	// EditorRole may submit, cancel and delete AIJobs; ViewerRole may read them;
	// MembersEditorRole may edit the members object. All ship in the operator chart.
	EditorRole        = "aif-aijob-editor"
	ViewerRole        = "aif-aijob-viewer"
	MembersEditorRole = "aif-aiproject-members-editor"
	// PoolViewerRole reads ComputePools, which are cluster-scoped: a namespace's
	// RoleBinding cannot grant it. One ClusterRoleBinding, PoolViewers, gives it
	// to every member of every AI project.
	PoolViewerRole = "aif-computepool-viewer"
	PoolViewers    = "aif-computepool-viewers"

	rancherProjectAnnotation = "field.cattle.io/projectId"
	conditionReady           = "Ready"

	// retryAfter is how soon a project not yet in place on every cluster is tried
	// again (a cluster unreachable, a namespace in another project).
	retryAfter = 2 * time.Minute
)

var (
	projectGVK = schema.GroupVersionKind{Group: "management.cattle.io", Version: "v3", Kind: "Project"}
	prtbGVK    = schema.GroupVersionKind{Group: "management.cattle.io", Version: "v3", Kind: "ProjectRoleTemplateBinding"}
)

// NamespaceFor is the namespace on local that holds a project's AIJobs.
func NamespaceFor(project string) string { return "aif-" + project }

// Rancher reaches Rancher's objects as the administrator who authorized the
// Settings token. Abstracted so the reconciler is testable without Rancher.
type Rancher interface {
	// Management reaches Rancher's management objects (projects, project role
	// bindings) on local.
	Management(ctx context.Context) (ctrl.Client, error)
	// Cluster reaches a downstream cluster.
	Cluster(ctx context.Context, clusterID string) (ctrl.Client, error)
}

// +kubebuilder:rbac:groups=ai-factory.suse.com,resources=aiprojects,verbs=get;list;watch;update;patch
// +kubebuilder:rbac:groups=ai-factory.suse.com,resources=aiprojects/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=ai-factory.suse.com,resources=aiprojectmembers,verbs=get;list;watch;create
// +kubebuilder:rbac:groups="",resources=namespaces,verbs=get;list;watch;create;delete
// +kubebuilder:rbac:groups=rbac.authorization.k8s.io,resources=rolebindings,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=rbac.authorization.k8s.io,resources=clusterrolebindings,verbs=get;list;watch;create;update;patch
// +kubebuilder:rbac:groups=rbac.authorization.k8s.io,resources=clusterroles,verbs=bind,resourceNames=aif-aijob-editor;aif-aijob-viewer;aif-aiproject-members-editor;aif-computepool-viewer

// Reconciler keeps one AIProject in place.
type Reconciler struct {
	ctrl.Client
	Rancher Rancher
}

func (r *Reconciler) Reconcile(ctx context.Context, req reconcile.Request) (reconcile.Result, error) {
	p := &v1alpha1.AIProject{}
	if err := r.Get(ctx, req.NamespacedName, p); err != nil {
		if apierrors.IsNotFound(err) {
			// Its namespace on local and the RoleBindings in it are owned by it and
			// go with it. Rancher projects and downstream namespaces are left alone:
			// they may hold work and data that is not the operator's to delete.
			return reconcile.Result{}, r.syncPoolViewers(ctx)
		}
		return reconcile.Result{}, err
	}
	if !p.DeletionTimestamp.IsZero() {
		return reconcile.Result{}, nil
	}
	before := p.Status.DeepCopy()

	ns := NamespaceFor(p.Name)
	if err := r.ensureLocal(ctx, p, ns); err != nil {
		return reconcile.Result{}, err
	}
	members, err := r.members(ctx, p, ns)
	if err != nil {
		return reconcile.Result{}, err
	}
	if err := r.syncLocalRoleBindings(ctx, p, ns, members); err != nil {
		return reconcile.Result{}, err
	}

	p.Status.Namespace = ns
	p.Status.Clusters = nil
	ready := true
	for _, c := range p.Spec.Clusters {
		cs := r.syncCluster(ctx, p, c, members)
		ready = ready && cs.Ready
		p.Status.Clusters = append(p.Status.Clusters, cs)
	}
	cond := metav1.Condition{Type: conditionReady, Status: metav1.ConditionTrue, Reason: "InPlace", Message: "namespace, members and every cluster are in place", ObservedGeneration: p.Generation}
	if !ready {
		cond.Status, cond.Reason, cond.Message = metav1.ConditionFalse, "ClusterNotReady", "see status.clusters"
	}
	meta.SetStatusCondition(&p.Status.Conditions, cond)
	if !equalStatus(before, &p.Status) {
		if err := r.Status().Update(ctx, p); err != nil {
			return reconcile.Result{}, err
		}
	}
	if err := r.syncPoolViewers(ctx); err != nil {
		return reconcile.Result{}, err
	}
	if !ready {
		return reconcile.Result{RequeueAfter: retryAfter}, nil
	}
	return reconcile.Result{}, nil
}

// ensureLocal makes the project's namespace on local, owned by the project, and
// the empty members object its owners edit.
func (r *Reconciler) ensureLocal(ctx context.Context, p *v1alpha1.AIProject, ns string) error {
	owner := metav1.OwnerReference{APIVersion: v1alpha1.GroupVersion.String(), Kind: "AIProject", Name: p.Name, UID: p.UID}
	n := &corev1.Namespace{}
	switch err := r.Get(ctx, types.NamespacedName{Name: ns}, n); {
	case apierrors.IsNotFound(err):
		n = &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: ns, Labels: map[string]string{ProjectLabel: p.Name}, OwnerReferences: []metav1.OwnerReference{owner}}}
		log.FromContext(ctx).Info("Creating AI project namespace", "namespace", ns, "project", p.Name)
		if err := r.Create(ctx, n); err != nil {
			return err
		}
	case err != nil:
		return err
	case n.Labels[ProjectLabel] != p.Name:
		return fmt.Errorf("namespace %s exists and does not belong to AI project %s", ns, p.Name)
	}
	m := &v1alpha1.AIProjectMembers{}
	switch err := r.Get(ctx, types.NamespacedName{Namespace: ns, Name: MembersName}, m); {
	case apierrors.IsNotFound(err):
		m = &v1alpha1.AIProjectMembers{ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: MembersName}}
		return ctrl.IgnoreAlreadyExists(r.Create(ctx, m))
	default:
		return err
	}
}

// members is everyone in the project with their strongest role: the owners in
// the spec, then the members object.
func (r *Reconciler) members(ctx context.Context, p *v1alpha1.AIProject, ns string) ([]v1alpha1.AIProjectMember, error) {
	rank := map[v1alpha1.AIProjectRole]int{v1alpha1.AIProjectRoleOwner: 3, v1alpha1.AIProjectRoleMember: 2, v1alpha1.AIProjectRoleReadOnly: 1}
	best := map[v1alpha1.AIProjectSubject]v1alpha1.AIProjectRole{}
	add := func(s v1alpha1.AIProjectSubject, role v1alpha1.AIProjectRole) {
		if rank[role] > rank[best[s]] {
			best[s] = role
		}
	}
	for _, o := range p.Spec.Owners {
		add(o, v1alpha1.AIProjectRoleOwner)
	}
	m := &v1alpha1.AIProjectMembers{}
	if err := r.Get(ctx, types.NamespacedName{Namespace: ns, Name: MembersName}, m); ctrl.IgnoreNotFound(err) != nil {
		return nil, err
	}
	for _, mm := range m.Spec.Members {
		add(mm.AIProjectSubject, mm.Role)
	}
	out := make([]v1alpha1.AIProjectMember, 0, len(best))
	for s, role := range best {
		out = append(out, v1alpha1.AIProjectMember{AIProjectSubject: s, Role: role})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Kind+out[i].Name < out[j].Kind+out[j].Name })
	return out, nil
}

func subject(s v1alpha1.AIProjectSubject) rbacv1.Subject {
	kind := rbacv1.UserKind
	if s.Kind == "Group" {
		kind = rbacv1.GroupKind
	}
	return rbacv1.Subject{Kind: kind, APIGroup: rbacv1.GroupName, Name: s.Name}
}

func shortHash(parts ...string) string {
	sum := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return hex.EncodeToString(sum[:6])
}

// syncLocalRoleBindings: in the project's namespace on local, owners and members
// may run jobs, read-only members see them, and owners may edit the members.
func (r *Reconciler) syncLocalRoleBindings(ctx context.Context, p *v1alpha1.AIProject, ns string, members []v1alpha1.AIProjectMember) error {
	want := map[string]*rbacv1.RoleBinding{}
	bind := func(role string, s v1alpha1.AIProjectSubject) {
		rb := &rbacv1.RoleBinding{
			ObjectMeta: metav1.ObjectMeta{Name: "aif-" + shortHash(role, s.Kind, s.Name), Namespace: ns, Labels: map[string]string{ProjectLabel: p.Name}},
			RoleRef:    rbacv1.RoleRef{APIGroup: rbacv1.GroupName, Kind: "ClusterRole", Name: role},
			Subjects:   []rbacv1.Subject{subject(s)},
		}
		want[rb.Name] = rb
	}
	for _, m := range members {
		switch m.Role {
		case v1alpha1.AIProjectRoleOwner:
			bind(EditorRole, m.AIProjectSubject)
			bind(MembersEditorRole, m.AIProjectSubject)
		case v1alpha1.AIProjectRoleMember:
			bind(EditorRole, m.AIProjectSubject)
		case v1alpha1.AIProjectRoleReadOnly:
			bind(ViewerRole, m.AIProjectSubject)
		}
	}
	have := &rbacv1.RoleBindingList{}
	if err := r.List(ctx, have, ctrl.InNamespace(ns), ctrl.MatchingLabels{ProjectLabel: p.Name}); err != nil {
		return err
	}
	for i := range have.Items {
		if _, keep := want[have.Items[i].Name]; keep {
			delete(want, have.Items[i].Name) // the name encodes role and subject
			continue
		}
		if err := r.Delete(ctx, &have.Items[i]); ctrl.IgnoreNotFound(err) != nil {
			return err
		}
	}
	for _, rb := range want {
		if err := r.Create(ctx, rb); ctrl.IgnoreAlreadyExists(err) != nil {
			return err
		}
	}
	return nil
}

// syncCluster puts the project in place on one cluster: its Rancher project,
// its namespace in that project, and its members' Rancher role bindings.
func (r *Reconciler) syncCluster(ctx context.Context, p *v1alpha1.AIProject, c v1alpha1.AIProjectCluster, members []v1alpha1.AIProjectMember) v1alpha1.AIProjectClusterStatus {
	cs := v1alpha1.AIProjectClusterStatus{ClusterID: c.ClusterID, Namespace: c.Namespace}
	fail := func(format string, a ...any) v1alpha1.AIProjectClusterStatus {
		cs.Message = fmt.Sprintf(format, a...)
		return cs
	}
	mgmt, err := r.Rancher.Management(ctx)
	if err != nil {
		return fail("cannot reach Rancher: %v", err)
	}
	projectID, err := r.rancherProject(ctx, mgmt, p, c)
	if err != nil {
		return fail("Rancher project: %v", err)
	}
	cs.ProjectID = projectID
	want := c.ClusterID + ":" + projectID

	down, err := r.Rancher.Cluster(ctx, c.ClusterID)
	if err != nil {
		return fail("cannot reach cluster %s: %v", c.ClusterID, err)
	}
	ns := &corev1.Namespace{}
	switch err := down.Get(ctx, types.NamespacedName{Name: c.Namespace}, ns); {
	case apierrors.IsNotFound(err):
		ns = &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: c.Namespace, Annotations: map[string]string{rancherProjectAnnotation: want}}}
		if err := down.Create(ctx, ns); err != nil {
			return fail("create namespace %s: %v", c.Namespace, err)
		}
	case err != nil:
		return fail("read namespace %s: %v", c.Namespace, err)
	default:
		got := ns.Annotations[rancherProjectAnnotation]
		if got != "" && got != want {
			// Not ours to move: it holds another project's work.
			return fail("namespace %s is in Rancher project %s, not %s", c.Namespace, got, want)
		}
		if got == "" {
			if ns.Annotations == nil {
				ns.Annotations = map[string]string{}
			}
			ns.Annotations[rancherProjectAnnotation] = want
			if err := down.Update(ctx, ns); err != nil {
				return fail("move namespace %s into the project: %v", c.Namespace, err)
			}
		}
	}

	if err := r.syncPRTBs(ctx, mgmt, p, c.ClusterID, projectID, members); err != nil {
		return fail("member role bindings: %v", err)
	}
	cs.Ready = true
	return cs
}

// rancherProject is the project's Rancher project on the cluster: the one the
// spec adopts, else the one made for it before, else a new one.
func (r *Reconciler) rancherProject(ctx context.Context, mgmt ctrl.Client, p *v1alpha1.AIProject, c v1alpha1.AIProjectCluster) (string, error) {
	if c.ProjectID != "" {
		u := &unstructured.Unstructured{}
		u.SetGroupVersionKind(projectGVK)
		if err := mgmt.Get(ctx, types.NamespacedName{Namespace: c.ClusterID, Name: c.ProjectID}, u); err != nil {
			return "", err
		}
		return c.ProjectID, nil
	}
	list := &unstructured.UnstructuredList{}
	list.SetGroupVersionKind(projectGVK.GroupVersion().WithKind("ProjectList"))
	if err := mgmt.List(ctx, list, ctrl.InNamespace(c.ClusterID), ctrl.MatchingLabels{ProjectLabel: p.Name}); err != nil {
		return "", err
	}
	if len(list.Items) > 0 {
		return list.Items[0].GetName(), nil
	}
	u := &unstructured.Unstructured{}
	u.SetGroupVersionKind(projectGVK)
	u.SetNamespace(c.ClusterID)
	u.SetGenerateName("p-")
	u.SetLabels(map[string]string{ProjectLabel: p.Name})
	display := p.Spec.DisplayName
	if display == "" {
		display = p.Name
	}
	u.Object["spec"] = map[string]interface{}{"clusterName": c.ClusterID, "displayName": display, "description": "AI Factory project " + p.Name}
	if err := mgmt.Create(ctx, u); err != nil {
		return "", err
	}
	log.FromContext(ctx).Info("Created Rancher project for AI project", "project", p.Name, "cluster", c.ClusterID, "rancherProject", u.GetName())
	return u.GetName(), nil
}

var rancherRole = map[v1alpha1.AIProjectRole]string{
	v1alpha1.AIProjectRoleOwner:    "project-owner",
	v1alpha1.AIProjectRoleMember:   "project-member",
	v1alpha1.AIProjectRoleReadOnly: "read-only",
}

// syncPRTBs keeps one Rancher project role binding per member, with the Rancher
// role matching theirs. Only bindings it made are touched. A member who already
// has that role through a binding someone else made (the project's creator, an
// adopted project's members) is left with it: Rancher refuses a duplicate.
func (r *Reconciler) syncPRTBs(ctx context.Context, mgmt ctrl.Client, p *v1alpha1.AIProject, clusterID, projectID string, members []v1alpha1.AIProjectMember) error {
	ns := clusterID + "-" + projectID
	want := map[string]*unstructured.Unstructured{}
	for _, m := range members {
		role := rancherRole[m.Role]
		b := &unstructured.Unstructured{}
		b.SetGroupVersionKind(prtbGVK)
		b.SetNamespace(ns)
		b.SetName("aif-" + shortHash(role, m.Kind, m.Name))
		b.SetLabels(map[string]string{ProjectLabel: p.Name})
		b.Object["projectName"] = clusterID + ":" + projectID
		b.Object["roleTemplateName"] = role
		if m.Kind == "Group" {
			b.Object["groupPrincipalName"] = m.Name
		} else {
			b.Object["userName"] = m.Name
		}
		want[b.GetName()] = b
	}
	all := &unstructured.UnstructuredList{}
	all.SetGroupVersionKind(prtbGVK.GroupVersion().WithKind("ProjectRoleTemplateBindingList"))
	if err := mgmt.List(ctx, all, ctrl.InNamespace(ns)); err != nil {
		return err
	}
	grantsOf := func(b *unstructured.Unstructured) string {
		role, _, _ := unstructured.NestedString(b.Object, "roleTemplateName")
		who, _, _ := unstructured.NestedString(b.Object, "userName")
		if who == "" {
			g, _, _ := unstructured.NestedString(b.Object, "groupPrincipalName")
			who = "group:" + g
		}
		return role + "/" + who
	}
	others := map[string]bool{}
	for i := range all.Items {
		b := &all.Items[i]
		if b.GetLabels()[ProjectLabel] != p.Name {
			others[grantsOf(b)] = true
			continue
		}
		if _, keep := want[b.GetName()]; keep {
			delete(want, b.GetName()) // the name encodes role and subject
			continue
		}
		if err := mgmt.Delete(ctx, b); ctrl.IgnoreNotFound(err) != nil {
			return err
		}
	}
	for name, b := range want {
		if others[grantsOf(b)] {
			delete(want, name)
		}
	}
	for _, b := range want {
		if err := mgmt.Create(ctx, b); ctrl.IgnoreAlreadyExists(err) != nil {
			return err
		}
	}
	return nil
}

// syncPoolViewers makes the PoolViewers ClusterRoleBinding name every member of
// every AI project, so each can choose a compute pool.
func (r *Reconciler) syncPoolViewers(ctx context.Context) error {
	projects := &v1alpha1.AIProjectList{}
	if err := r.List(ctx, projects); err != nil {
		return err
	}
	seen := map[rbacv1.Subject]bool{}
	subjects := []rbacv1.Subject{}
	for i := range projects.Items {
		p := &projects.Items[i]
		if !p.DeletionTimestamp.IsZero() {
			continue
		}
		members, err := r.members(ctx, p, NamespaceFor(p.Name))
		if err != nil {
			return err
		}
		for _, m := range members {
			if s := subject(m.AIProjectSubject); !seen[s] {
				seen[s] = true
				subjects = append(subjects, s)
			}
		}
	}
	sort.Slice(subjects, func(i, j int) bool { return subjects[i].Kind+subjects[i].Name < subjects[j].Kind+subjects[j].Name })

	crb := &rbacv1.ClusterRoleBinding{}
	err := r.Get(ctx, types.NamespacedName{Name: PoolViewers}, crb)
	if apierrors.IsNotFound(err) {
		return r.Create(ctx, &rbacv1.ClusterRoleBinding{
			ObjectMeta: metav1.ObjectMeta{Name: PoolViewers},
			RoleRef:    rbacv1.RoleRef{APIGroup: rbacv1.GroupName, Kind: "ClusterRole", Name: PoolViewerRole},
			Subjects:   subjects,
		})
	}
	if err != nil {
		return err
	}
	if sameSubjects(crb.Subjects, subjects) {
		return nil
	}
	crb.Subjects = subjects
	return r.Update(ctx, crb)
}

func sameSubjects(a, b []rbacv1.Subject) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// equalStatus compares statuses ignoring condition transition times.
func equalStatus(a, b *v1alpha1.AIProjectStatus) bool {
	ac, bc := a.DeepCopy(), b.DeepCopy()
	for i := range ac.Conditions {
		ac.Conditions[i].LastTransitionTime = metav1.Time{}
	}
	for i := range bc.Conditions {
		bc.Conditions[i].LastTransitionTime = metav1.Time{}
	}
	return fmt.Sprintf("%+v", *ac) == fmt.Sprintf("%+v", *bc)
}

// SetupWithManager reconciles a project when it changes and when its members
// object changes; one not yet in place is retried.
func (r *Reconciler) SetupWithManager(mgr controllerruntime.Manager) error {
	toProject := handler.EnqueueRequestsFromMapFunc(func(_ context.Context, o ctrl.Object) []reconcile.Request {
		name, found := strings.CutPrefix(o.GetNamespace(), "aif-")
		if !found || o.GetName() != MembersName {
			return nil
		}
		return []reconcile.Request{{NamespacedName: types.NamespacedName{Name: name}}}
	})
	return controllerruntime.NewControllerManagedBy(mgr).
		Named("aiproject").
		For(&v1alpha1.AIProject{}).
		Watches(&v1alpha1.AIProjectMembers{}, toProject).
		Complete(r)
}
