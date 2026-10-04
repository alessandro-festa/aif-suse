<script lang="ts">
import { defineComponent } from 'vue';

/**
 * One collapsible block of the Submit form.
 *
 * The form asks for six groups of things and only two of them matter on a typical submission, so
 * the rest start collapsed. A collapsed section still has to say what is in it — otherwise closing
 * it hides state the user set — which is what `summary` is for: it shows the current value, not a
 * description. A section containing a failing field should be opened by its parent through `open`.
 */
export default defineComponent({
  name:  'FormSection',
  props: {
    title:   { type: String, required: true },
    /** Current state of the fields inside, shown on the header line. */
    summary: { type: String, default: '' },
    /** Explanatory prose, on an info bubble rather than as a paragraph under the fields. */
    info:    { type: String, default: '' },
    /** Start expanded. A later change to true forces the section open; see the watcher. */
    open:    { type: Boolean, default: true },
  },
  data() {
    return { expanded: this.open };
  },
  watch: {
    open(v: boolean) {
      // Opens, never closes. Parents compute `open` from "is anything set in here", which goes
      // false the moment a field is cleared -- collapsing the section under the cursor of whoever
      // just cleared it. Closing stays the user's decision.
      if (v) {
        this.expanded = true;
      }
    },
  },
});
</script>

<template>
  <section :class="['tj-sec', { 'tj-sec-open': expanded }]">
    <div class="tj-sec-head">
      <button
        type="button"
        class="tj-sec-toggle"
        @click="expanded = !expanded"
      >
        <i :class="['icon', expanded ? 'icon-chevron-down' : 'icon-chevron-right']" />
        <h2>{{ title }}</h2>
        <span
          v-if="summary && !expanded"
          class="text-muted tj-sec-sum"
        >{{ summary }}</span>
      </button>
      <i
        v-if="info"
        v-clean-tooltip="info"
        class="icon icon-info tj-sec-info"
      />
    </div>
    <div
      v-show="expanded"
      class="tj-sec-body"
    >
      <slot />
    </div>
  </section>
</template>

<style lang="scss" scoped>
.tj-sec { border-top: 1px solid var(--border); }
.tj-sec-head { display: flex; align-items: center; gap: 8px; }
.tj-sec-toggle {
  display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0;
  background: none; border: none; cursor: pointer; padding: 12px 0 8px; text-align: left;
  h2 { margin: 0; font-size: 16px; }
  .icon { color: var(--muted); }
  &:hover h2 { color: var(--link); }
}
.tj-sec-sum { font-size: 12px; margin-left: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 55%; }
.tj-sec-info { color: var(--muted); cursor: help; font-size: 16px; &:hover { color: var(--link); } }
.tj-sec-body { padding-bottom: 12px; }
</style>
