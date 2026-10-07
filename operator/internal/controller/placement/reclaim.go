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
	"context"
	"fmt"
	"time"

	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	controllerruntime "sigs.k8s.io/controller-runtime"
	ctrl "sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/manager"

	"github.com/SUSE/aif-operator/api/v1alpha1"
)

// Idle reclaim. In a pool with reclaim settings, every running run the queue
// placed is sampled about every minute. A run under the pool's idle threshold
// for its whole idle timeout is reclaimed when a run waiting in the queue would
// fit in its place (or always, if the pool says so): the waiting run is placed
// on the pool at once, and the AIJob controller uninstalls the idle one and, by
// its reclaim policy, puts it back in the queue (Suspend) or ends it
// (Terminate). Placing the waiting run first is the hand-off: it counts as
// placed in the pool, so the idle run, earlier in the queue, does not take the
// room back.

// DefaultActivityResync is how often runs are sampled.
const DefaultActivityResync = time.Minute

// DefaultIdleThreshold is the pool's idle threshold when it sets none.
const DefaultIdleThreshold = 5

// +kubebuilder:rbac:groups=ai-factory.suse.com,resources=aijobs,verbs=get;list;watch;patch
// +kubebuilder:rbac:groups=ai-factory.suse.com,resources=aijobs/status,verbs=get;patch

// Reclaimer samples runs and reclaims idle ones. It runs on a timer, not on
// events: activity changes without any object changing.
type Reclaimer struct {
	ctrl.Client
	Probe  Probe
	Resync time.Duration
	Now    func() time.Time
}

func (r *Reclaimer) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

// Start runs the sampling loop until ctx ends.
func (r *Reclaimer) Start(ctx context.Context) error {
	resync := r.Resync
	if resync <= 0 {
		resync = DefaultActivityResync
	}
	t := time.NewTicker(resync)
	defer t.Stop()
	for {
		if err := r.Pass(ctx); err != nil {
			log.FromContext(ctx).Error(err, "idle reclaim pass failed")
		}
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
		}
	}
}

// NeedLeaderElection: one replica samples and reclaims.
func (r *Reclaimer) NeedLeaderElection() bool { return true }

// SetupWithManager adds the loop to the manager.
func (r *Reclaimer) SetupWithManager(mgr controllerruntime.Manager) error {
	return mgr.Add(manager.Runnable(r))
}

// Pass samples every run in a reclaiming pool once and reclaims what is due.
func (r *Reclaimer) Pass(ctx context.Context) error {
	jobs := &v1alpha1.AIJobList{}
	if err := r.List(ctx, jobs); err != nil {
		return err
	}
	poolList := &v1alpha1.ComputePoolList{}
	if err := r.List(ctx, poolList); err != nil {
		return err
	}
	pools := map[string]*v1alpha1.ComputePool{}
	for i := range poolList.Items {
		pools[poolList.Items[i].Name] = &poolList.Items[i]
	}
	waiting, inflight := queueState(jobs.Items, poolList.Items)
	placer := &Reconciler{Client: r.Client}
	projects := map[string]*v1alpha1.AIProject{}
	claimed := map[string]bool{} // waiting runs already handed a pool in this pass

	for i := range jobs.Items {
		j := &jobs.Items[i]
		at := j.Status.Placement
		if at == nil || j.Status.Phase != v1alpha1.AIJobPhaseRunning || j.Spec.Cancel || !j.DeletionTimestamp.IsZero() {
			continue
		}
		if _, asked := j.Annotations[v1alpha1.AIJobReclaimAnnotation]; asked {
			continue
		}
		pool := pools[at.Pool]
		if pool == nil || pool.Spec.Reclaim == nil {
			continue
		}
		now := metav1.NewTime(r.now())
		pct, source, err := sample(ctx, r.Probe, j, pool)
		var act *v1alpha1.AIJobActivity
		var v verdict
		if err != nil {
			act = j.Status.Activity.DeepCopy()
			if act == nil {
				act = &v1alpha1.AIJobActivity{}
			}
			act.Message = "not sampled: " + err.Error()
		} else {
			act = nextActivity(j.Status.Activity, pct, source, threshold(pool.Spec.Reclaim), now)
			contender := r.contender(ctx, placer, j, pool, waiting, inflight, projects, claimed)
			v = decide(j, pool, act, now.Time, contenderName(contender))
			act.Message = v.why
			if v.reclaim && contender != nil {
				// the hand-off: the waiting run takes the pool before the idle one leaves
				if err := placer.place(ctx, contender, pool, spanNamespace(projects, contender, pool)); err != nil {
					return err
				}
				claimed[contender.Namespace+"/"+contender.Name] = true
				n, _ := needsOf(contender)
				inflight[pool.Name] = append(inflight[pool.Name], n)
			}
		}
		before := j.DeepCopy()
		j.Status.Activity = act
		if err := r.Status().Patch(ctx, j, ctrl.MergeFrom(before)); err != nil {
			return err
		}
		if v.reclaim {
			before := j.DeepCopy()
			if j.Annotations == nil {
				j.Annotations = map[string]string{}
			}
			j.Annotations[v1alpha1.AIJobReclaimAnnotation] = string(v.policy)
			if err := r.Patch(ctx, j, ctrl.MergeFrom(before)); err != nil {
				return err
			}
			log.FromContext(ctx).Info("Reclaiming idle training run", "aijob", j.Namespace+"/"+j.Name, "pool", pool.Name, "policy", v.policy, "why", v.why)
		}
	}
	return nil
}

// contender is the first run waiting in the queue (one the placement controller
// could not place) whose project spans the pool's cluster and that would fit if
// j left the pool; nil when there is none. A run that is waiting because it was
// itself reclaimed for being idle is no contender: it resumes when room frees,
// or two idle runs would take the pool from each other in turn.
func (r *Reclaimer) contender(ctx context.Context, placer *Reconciler, j *v1alpha1.AIJob, pool *v1alpha1.ComputePool,
	waiting []*v1alpha1.AIJob, inflight map[string][]Needs, projects map[string]*v1alpha1.AIProject, claimed map[string]bool) *v1alpha1.AIJob {
	freed, err := needsOf(j)
	if err != nil {
		return nil
	}
	for _, w := range waiting {
		if claimed[w.Namespace+"/"+w.Name] || w.Status.PlacementMessage == "" ||
			meta.IsStatusConditionTrue(w.Status.Conditions, v1alpha1.AIJobConditionReclaimed) {
			continue
		}
		project, err := placer.projectOf(ctx, w.Namespace, projects)
		if err != nil || project == nil || !spans(project, pool.Spec.ClusterID) {
			continue
		}
		n, err := needsOf(w)
		if err != nil {
			continue
		}
		if fitsIfFreed(n, pool, inflight[pool.Name], freed) {
			return w
		}
	}
	return nil
}

func spans(p *v1alpha1.AIProject, clusterID string) bool {
	for _, c := range p.Spec.Clusters {
		if c.ClusterID == clusterID {
			return true
		}
	}
	return false
}

// spanNamespace is the waiting run's project namespace on the pool's cluster.
func spanNamespace(projects map[string]*v1alpha1.AIProject, w *v1alpha1.AIJob, pool *v1alpha1.ComputePool) string {
	if p := projects[w.Namespace]; p != nil {
		for _, c := range p.Spec.Clusters {
			if c.ClusterID == pool.Spec.ClusterID {
				return c.Namespace
			}
		}
	}
	return ""
}

func contenderName(w *v1alpha1.AIJob) string {
	if w == nil {
		return ""
	}
	return types.NamespacedName{Namespace: w.Namespace, Name: w.Name}.String()
}

// fitsIfFreed says whether the run n would fit the pool once what freed holds
// is released.
func fitsIfFreed(n Needs, p *v1alpha1.ComputePool, inflight []Needs, freed Needs) bool {
	f := freeOf(p, inflight)
	f.GPUs += freed.GPUs()
	f.CPU.Add(freed.CPU)
	f.Memory.Add(freed.Memory)
	return refuse(n, p, f) == ""
}

func threshold(rc *v1alpha1.ComputePoolReclaim) int32 {
	if rc.IdleThreshold > 0 {
		return rc.IdleThreshold
	}
	return DefaultIdleThreshold
}

// nextActivity folds a sample into the run's activity: the idle clock starts at
// the first sample under the threshold and stops at the first one above it.
func nextActivity(prev *v1alpha1.AIJobActivity, pct int32, source string, threshold int32, now metav1.Time) *v1alpha1.AIJobActivity {
	a := &v1alpha1.AIJobActivity{Source: source, Utilisation: pct, SampledAt: &now}
	if prev != nil {
		a.LastActiveAt, a.IdleSince = prev.LastActiveAt, prev.IdleSince
	}
	if pct >= threshold {
		a.LastActiveAt, a.IdleSince = &now, nil
	} else if a.IdleSince == nil {
		a.IdleSince = &now
	}
	return a
}

type verdict struct {
	reclaim bool
	policy  v1alpha1.AIJobReclaimPolicy
	why     string // what reclaim waits for, or why it happens
}

// idleTimeout is the run's own timeout when it asks for one, capped by the
// pool's ceiling; otherwise the pool's.
func idleTimeout(rc *v1alpha1.ComputePoolReclaim, jr *v1alpha1.AIJobReclaim) (time.Duration, error) {
	pool, err := parseIdleDuration(rc.IdleTimeout)
	if err != nil {
		return 0, err
	}
	if jr == nil || jr.IdleTimeout == "" {
		return time.Duration(pool) * time.Minute, nil
	}
	want, err := parseIdleDuration(jr.IdleTimeout)
	if err != nil {
		return 0, err
	}
	ceiling := pool
	if rc.MaxIdleTimeout != "" {
		if ceiling, err = parseIdleDuration(rc.MaxIdleTimeout); err != nil {
			return 0, err
		}
	}
	return time.Duration(min(want, ceiling)) * time.Minute, nil
}

// decide says whether an idle run is reclaimed now. contender is the waiting
// run that would take its place ("" for none).
func decide(j *v1alpha1.AIJob, pool *v1alpha1.ComputePool, act *v1alpha1.AIJobActivity, now time.Time, contender string) verdict {
	rc := pool.Spec.Reclaim
	v := verdict{policy: v1alpha1.AIJobReclaimSuspend}
	if j.Spec.Reclaim != nil && j.Spec.Reclaim.Policy != "" {
		v.policy = j.Spec.Reclaim.Policy
	}
	if act.IdleSince == nil {
		return v
	}
	timeout, err := idleTimeout(rc, j.Spec.Reclaim)
	if err != nil {
		v.why = "cannot read the idle timeout: " + err.Error()
		return v
	}
	idle := now.Sub(act.IdleSince.Time).Truncate(time.Minute)
	switch {
	case idle < timeout:
		v.why = fmt.Sprintf("idle for %s of %s", idle, timeout)
	case v.policy == v1alpha1.AIJobReclaimNever:
		v.why = fmt.Sprintf("idle for %s; its reclaim policy is Never", idle)
	case j.Spec.Pool != "":
		v.why = fmt.Sprintf("idle for %s; not reclaimed, as it was submitted to pool %s rather than queued", idle, j.Spec.Pool)
	case contender == "" && (rc.OnlyWhenContended == nil || *rc.OnlyWhenContended):
		v.why = fmt.Sprintf("idle for %s; reclaimed when a waiting run needs the pool", idle)
	default:
		v.reclaim = true
		v.why = fmt.Sprintf("idle for %s (under %d%% of its %s)", idle, threshold(rc), act.Source)
		if contender != "" {
			v.why += ", for " + contender
		}
	}
	return v
}
