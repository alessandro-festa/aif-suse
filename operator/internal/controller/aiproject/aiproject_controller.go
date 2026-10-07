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

// Package aiproject gives every AI project its own namespace on the management
// cluster, where its AIJobs live, and keeps who may use it in step with the
// Rancher project's members. An AI project is a Rancher project on a downstream
// cluster labelled ai-factory.suse.com/ai-project=true; one namespace per such
// project keeps the namespace count to the projects that run AI work.
package aiproject

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"strings"

	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	controllerruntime "sigs.k8s.io/controller-runtime"
	ctrl "sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	"sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	"github.com/SUSE/aif-operator/internal/infra/rancher"
)

const (
	// AIProjectLabel marks a Rancher project as an AI project.
	AIProjectLabel = "ai-factory.suse.com/ai-project"
	// ClusterLabel and ProjectLabel say which Rancher project a namespace on
	// local belongs to (a label value cannot hold the "cluster:project" form).
	ClusterLabel = "ai-factory.suse.com/cluster"
	ProjectLabel = "ai-factory.suse.com/project"
	// managedLabel marks the RoleBindings this controller owns.
	managedLabel = "ai-factory.suse.com/managed-by"
	managedBy    = "aiproject"

	// EditorRole may submit, cancel and delete AIJobs; ViewerRole may read
	// them. Both ship in the operator chart.
	EditorRole = "aif-aijob-editor"
	ViewerRole = "aif-aijob-viewer"
	// PoolViewerRole reads ComputePools, which are cluster-scoped: a namespace's
	// RoleBinding cannot grant it. One ClusterRoleBinding, PoolViewers, gives it
	// to every member of any AI project, for the Submit page's pool picker.
	PoolViewerRole = "aif-computepool-viewer"
	PoolViewers    = "aif-computepool-viewers"
)

var (
	projectGVK = schema.GroupVersionKind{Group: "management.cattle.io", Version: "v3", Kind: "Project"}
	prtbGVK    = schema.GroupVersionKind{Group: "management.cattle.io", Version: "v3", Kind: "ProjectRoleTemplateBinding"}
)

// roleFor maps a Rancher project role to AIJob access: owners and members
// submit, read-only members view. Other role templates grant nothing here.
func roleFor(roleTemplate string) string {
	switch roleTemplate {
	case "project-owner", "project-member":
		return EditorRole
	case "read-only":
		return ViewerRole
	}
	return ""
}

// NamespaceFor is the namespace on local that holds a project's AIJobs.
func NamespaceFor(clusterID, projectID string) string {
	return "aif-" + clusterID + "-" + projectID
}

// +kubebuilder:rbac:groups=management.cattle.io,resources=projects;projectroletemplatebindings,verbs=get;list;watch
// +kubebuilder:rbac:groups="",resources=namespaces,verbs=get;list;watch;create;delete
// +kubebuilder:rbac:groups=rbac.authorization.k8s.io,resources=rolebindings,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=rbac.authorization.k8s.io,resources=clusterroles,verbs=bind,resourceNames=aif-aijob-editor;aif-aijob-viewer;aif-computepool-viewer
// +kubebuilder:rbac:groups=rbac.authorization.k8s.io,resources=clusterrolebindings,verbs=get;list;watch;create;update;patch

// Reconciler keeps one AI project's namespace and RoleBindings. Reconcile is
// keyed by the Rancher project (namespace = cluster ID, name = project ID).
type Reconciler struct {
	ctrl.Client
}

func (r *Reconciler) Reconcile(ctx context.Context, req reconcile.Request) (reconcile.Result, error) {
	clusterID, projectID := req.Namespace, req.Name
	if clusterID == rancher.LocalClusterID {
		return reconcile.Result{}, nil // Rancher's own cluster runs no AI work
	}
	nsName := NamespaceFor(clusterID, projectID)

	project := &unstructured.Unstructured{}
	project.SetGroupVersionKind(projectGVK)
	err := r.Get(ctx, req.NamespacedName, project)
	if apierrors.IsNotFound(err) {
		if err := r.syncPoolViewers(ctx); err != nil {
			return reconcile.Result{}, err
		}
		// The project is gone, so are its jobs: their finalizers uninstall them.
		ns := &corev1.Namespace{}
		if err := r.Get(ctx, types.NamespacedName{Name: nsName}, ns); err == nil && ns.Labels[ProjectLabel] == projectID && ns.DeletionTimestamp.IsZero() {
			log.FromContext(ctx).Info("Rancher project removed; deleting its AI project namespace", "namespace", nsName)
			return reconcile.Result{}, ctrl.IgnoreNotFound(r.Delete(ctx, ns))
		}
		return reconcile.Result{}, nil
	}
	if err != nil {
		return reconcile.Result{}, err
	}
	if project.GetLabels()[AIProjectLabel] != "true" {
		// Not (or no longer) an AI project. An existing namespace is left alone:
		// unmarking a project must not delete its jobs.
		return reconcile.Result{}, r.syncPoolViewers(ctx)
	}

	if err := r.ensureNamespace(ctx, nsName, clusterID, projectID, project); err != nil {
		return reconcile.Result{}, err
	}
	if err := r.syncRoleBindings(ctx, nsName, clusterID+":"+projectID); err != nil {
		return reconcile.Result{}, err
	}
	return reconcile.Result{}, r.syncPoolViewers(ctx)
}

// syncPoolViewers makes the PoolViewers ClusterRoleBinding name every member of
// every AI project, so each can pick a compute pool.
func (r *Reconciler) syncPoolViewers(ctx context.Context) error {
	projects := &unstructured.UnstructuredList{}
	projects.SetGroupVersionKind(projectGVK.GroupVersion().WithKind("ProjectList"))
	if err := r.List(ctx, projects, ctrl.MatchingLabels{AIProjectLabel: "true"}); err != nil {
		return err
	}
	ai := map[string]bool{}
	for _, p := range projects.Items {
		if p.GetNamespace() != rancher.LocalClusterID {
			ai[p.GetNamespace()+":"+p.GetName()] = true
		}
	}
	prtbs := &unstructured.UnstructuredList{}
	prtbs.SetGroupVersionKind(prtbGVK.GroupVersion().WithKind("ProjectRoleTemplateBindingList"))
	if err := r.List(ctx, prtbs); err != nil {
		return err
	}
	seen := map[rbacv1.Subject]bool{}
	subjects := []rbacv1.Subject{}
	for i := range prtbs.Items {
		pn, _, _ := unstructured.NestedString(prtbs.Items[i].Object, "projectName")
		if !ai[pn] {
			continue
		}
		if rb := desiredRoleBinding(&prtbs.Items[i], "", pn); rb != nil && !seen[rb.Subjects[0]] {
			seen[rb.Subjects[0]] = true
			subjects = append(subjects, rb.Subjects[0])
		}
	}
	sort.Slice(subjects, func(i, j int) bool { return subjects[i].Kind+subjects[i].Name < subjects[j].Kind+subjects[j].Name })

	crb := &rbacv1.ClusterRoleBinding{}
	err := r.Get(ctx, types.NamespacedName{Name: PoolViewers}, crb)
	if apierrors.IsNotFound(err) {
		crb = &rbacv1.ClusterRoleBinding{
			ObjectMeta: metav1.ObjectMeta{Name: PoolViewers, Labels: map[string]string{managedLabel: managedBy}},
			RoleRef:    rbacv1.RoleRef{APIGroup: rbacv1.GroupName, Kind: "ClusterRole", Name: PoolViewerRole},
			Subjects:   subjects,
		}
		return r.Create(ctx, crb)
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

func (r *Reconciler) ensureNamespace(ctx context.Context, name, clusterID, projectID string, project *unstructured.Unstructured) error {
	ns := &corev1.Namespace{}
	err := r.Get(ctx, types.NamespacedName{Name: name}, ns)
	if err == nil {
		return nil
	}
	if !apierrors.IsNotFound(err) {
		return err
	}
	display, _, _ := unstructured.NestedString(project.Object, "spec", "displayName")
	ns = &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{
		Name:        name,
		Labels:      map[string]string{ClusterLabel: clusterID, ProjectLabel: projectID, managedLabel: managedBy},
		Annotations: map[string]string{"ai-factory.suse.com/project-display-name": display},
	}}
	log.FromContext(ctx).Info("Creating AI project namespace", "namespace", name, "project", clusterID+":"+projectID)
	return r.Create(ctx, ns)
}

// syncRoleBindings makes the namespace's managed RoleBindings match the
// project's role bindings in Rancher, one per user or group with access.
func (r *Reconciler) syncRoleBindings(ctx context.Context, ns, projectName string) error {
	prtbs := &unstructured.UnstructuredList{}
	prtbs.SetGroupVersionKind(prtbGVK)
	if err := r.List(ctx, prtbs); err != nil {
		return err
	}
	want := map[string]*rbacv1.RoleBinding{}
	for i := range prtbs.Items {
		if rb := desiredRoleBinding(&prtbs.Items[i], ns, projectName); rb != nil {
			want[rb.Name] = rb
		}
	}

	have := &rbacv1.RoleBindingList{}
	if err := r.List(ctx, have, ctrl.InNamespace(ns), ctrl.MatchingLabels{managedLabel: managedBy}); err != nil {
		return err
	}
	for i := range have.Items {
		cur := &have.Items[i]
		w, keep := want[cur.Name]
		switch {
		case !keep:
			if err := r.Delete(ctx, cur); ctrl.IgnoreNotFound(err) != nil {
				return err
			}
		case cur.RoleRef != w.RoleRef:
			// roleRef is immutable: replace the binding.
			if err := r.Delete(ctx, cur); ctrl.IgnoreNotFound(err) != nil {
				return err
			}
			continue
		case !sameSubjects(cur.Subjects, w.Subjects):
			cur.Subjects = w.Subjects
			if err := r.Update(ctx, cur); err != nil {
				return err
			}
		}
		if keep && cur.RoleRef == w.RoleRef {
			delete(want, cur.Name)
		}
	}
	for _, rb := range want {
		if err := r.Create(ctx, rb); err != nil && !apierrors.IsAlreadyExists(err) {
			return err
		}
	}
	return nil
}

// desiredRoleBinding is the RoleBinding a PRTB calls for in the project's
// namespace, or nil when it is for another project or grants nothing here.
// Subjects are written as Rancher writes its own: the user ID as a User, the
// group principal as a Group.
func desiredRoleBinding(prtb *unstructured.Unstructured, ns, projectName string) *rbacv1.RoleBinding {
	if p, _, _ := unstructured.NestedString(prtb.Object, "projectName"); p != projectName {
		return nil
	}
	tmpl, _, _ := unstructured.NestedString(prtb.Object, "roleTemplateName")
	role := roleFor(tmpl)
	if role == "" {
		return nil
	}
	var subject rbacv1.Subject
	if u, _, _ := unstructured.NestedString(prtb.Object, "userName"); u != "" {
		subject = rbacv1.Subject{Kind: rbacv1.UserKind, APIGroup: rbacv1.GroupName, Name: u}
	} else if g, _, _ := unstructured.NestedString(prtb.Object, "groupPrincipalName"); g != "" {
		subject = rbacv1.Subject{Kind: rbacv1.GroupKind, APIGroup: rbacv1.GroupName, Name: g}
	} else {
		return nil
	}
	sum := sha256.Sum256([]byte(string(prtb.GetUID()) + "/" + role))
	return &rbacv1.RoleBinding{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "aif-prtb-" + hex.EncodeToString(sum[:6]),
			Namespace: ns,
			Labels:    map[string]string{managedLabel: managedBy},
			Annotations: map[string]string{
				"ai-factory.suse.com/prtb": prtb.GetNamespace() + "/" + prtb.GetName(),
			},
		},
		RoleRef:  rbacv1.RoleRef{APIGroup: rbacv1.GroupName, Kind: "ClusterRole", Name: role},
		Subjects: []rbacv1.Subject{subject},
	}
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

// SetupWithManager reconciles a project when it changes, when one of its
// role bindings changes, and when its namespace on local changes.
func (r *Reconciler) SetupWithManager(mgr controllerruntime.Manager) error {
	project := &unstructured.Unstructured{}
	project.SetGroupVersionKind(projectGVK)
	prtb := &unstructured.Unstructured{}
	prtb.SetGroupVersionKind(prtbGVK)

	toProject := handler.EnqueueRequestsFromMapFunc(func(_ context.Context, o ctrl.Object) []reconcile.Request {
		u, ok := o.(*unstructured.Unstructured)
		if !ok {
			return nil
		}
		p, _, _ := unstructured.NestedString(u.Object, "projectName")
		cluster, id, found := strings.Cut(p, ":")
		if !found {
			return nil
		}
		return []reconcile.Request{{NamespacedName: types.NamespacedName{Namespace: cluster, Name: id}}}
	})
	fromNamespace := handler.EnqueueRequestsFromMapFunc(func(_ context.Context, o ctrl.Object) []reconcile.Request {
		l := o.GetLabels()
		if l[managedLabel] != managedBy || l[ClusterLabel] == "" || l[ProjectLabel] == "" {
			return nil
		}
		return []reconcile.Request{{NamespacedName: types.NamespacedName{Namespace: l[ClusterLabel], Name: l[ProjectLabel]}}}
	})
	return controllerruntime.NewControllerManagedBy(mgr).
		Named("aiproject").
		For(project).
		Watches(prtb, toProject).
		Watches(&corev1.Namespace{}, fromNamespace).
		Complete(r)
}
