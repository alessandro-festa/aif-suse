<script lang="ts">
// The failing and warning checks that belong to one Submit tab, shown at the top of that tab.
// Rancher's side tabs mark a tab with an error icon but not the tab you are on, and nothing in the
// tab says why, so without this the marker reads as a ghost that moves to wherever you just were.
import { defineComponent, PropType } from 'vue';
import Banner from '@components/Banner/Banner.vue';
import { Check } from '../preflight';

export default defineComponent({
  name:       'TabProblems',
  components: { Banner },
  props:      { checks: { type: Array as PropType<Check[]>, default: () => [] } },
});
</script>

<template>
  <div
    v-if="checks.length"
    class="tj-tab-problems"
  >
    <Banner
      v-for="c in checks"
      :key="c.id + c.title"
      :color="c.severity === 'fail' ? 'error' : 'warning'"
    >
      <div>
        <b>{{ c.title }}</b>
        <div
          v-if="c.detail"
          class="tj-tab-problem-detail"
        >
          {{ c.detail }}
        </div>
      </div>
    </Banner>
  </div>
</template>

<style lang="scss" scoped>
.tj-tab-problems { margin-bottom: 12px; }
.tj-tab-problem-detail { font-size: 12px; margin-top: 2px; }
</style>
