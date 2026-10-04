<script lang="ts">
import { defineComponent, PropType } from 'vue';
import AppModal from '@shell/components/AppModal.vue';
import YamlEditor from '@shell/components/YamlEditor.vue';
import Banner from '@components/Banner/Banner.vue';
import { copyTextToClipboard } from '@shell/utils/clipboard';
import { downloadFile } from '@shell/utils/download';

export interface YamlDoc {
  /** Tab label */
  label: string;
  /** Rendered YAML, or '' while still loading */
  yaml: string;
  /** Suggested download name, without the .yaml suffix */
  filename: string;
  /** Shown above the editor: what this document is and what you can do with it */
  hint?: string;
}

/**
 * Read-only YAML viewer in a modal, with one tab per document.
 *
 * Deliberately read-only: editing a live object is what the resource's own detail page is for, and
 * a half-editor here would imply this page can save changes back, which it cannot.
 */
export default defineComponent({
  name:       'YamlViewer',
  components: {
    AppModal, YamlEditor, Banner
  },

  props: {
    title: {
      type:    String,
      default: 'YAML',
    },
    docs: {
      type:     Array as PropType<YamlDoc[]>,
      required: true,
    },
    /** Set while the caller is still fetching; the editor shows nothing rather than stale text */
    loading: {
      type:    Boolean,
      default: false,
    },
    error: {
      type:    String,
      default: '',
    },
  },

  emits: ['close'],

  data() {
    return {
      active: 0, copied: false, copyTimer: null as any
    };
  },

  computed: {
    current(): YamlDoc {
      return this.docs[this.active] || {
        label: '', yaml: '', filename: 'resource'
      };
    },
  },

  watch: {
    // The caller can swap the whole doc set (a different row); an index into the old set is meaningless.
    docs() {
      if (this.active >= this.docs.length) {
        this.active = 0;
      }
    },
  },

  beforeUnmount() {
    if (this.copyTimer) {
      clearTimeout(this.copyTimer);
    }
  },

  methods: {
    async copy() {
      await copyTextToClipboard(this.current.yaml);
      this.copied = true;
      if (this.copyTimer) {
        clearTimeout(this.copyTimer);
      }
      this.copyTimer = setTimeout(() => {
        this.copied = false;
      }, 1500);
    },
    download() {
      downloadFile(`${ this.current.filename }.yaml`, this.current.yaml, 'application/yaml');
    },
  },
});
</script>

<template>
  <AppModal
    :width="900"
    @close="$emit('close')"
  >
    <div class="yv">
      <header class="yv-header">
        <h3>{{ title }}</h3>
        <button
          class="btn role-link yv-close"
          aria-label="Close"
          @click="$emit('close')"
        >
          <i class="icon icon-close" />
        </button>
      </header>

      <div
        v-if="docs.length > 1"
        class="yv-tabs"
      >
        <button
          v-for="(d, i) in docs"
          :key="d.label"
          :class="['yv-tab', { active: i === active }]"
          @click="active = i"
        >
          {{ d.label }}
        </button>
      </div>

      <Banner
        v-if="error"
        color="error"
        :label="error"
      />
      <p
        v-else-if="current.hint"
        class="text-muted yv-hint"
      >
        {{ current.hint }}
      </p>

      <div class="yv-body">
        <p
          v-if="loading"
          class="text-muted"
        >
          Loading…
        </p>
        <YamlEditor
          v-else-if="current.yaml"
          :key="current.label"
          :value="current.yaml"
          editor-mode="VIEW_CODE"
          :scrolling="true"
          class="yv-editor"
        />
      </div>

      <footer class="yv-footer">
        <button
          class="btn role-secondary btn-sm"
          :disabled="!current.yaml"
          @click="download()"
        >
          <i class="icon icon-download" /> Download
        </button>
        <button
          class="btn role-primary btn-sm"
          :disabled="!current.yaml"
          @click="copy()"
        >
          <i :class="['icon', copied ? 'icon-checkmark' : 'icon-copy']" /> {{ copied ? 'Copied' : 'Copy' }}
        </button>
      </footer>
    </div>
  </AppModal>
</template>

<style lang="scss" scoped>
.yv { display: flex; flex-direction: column; padding: 16px; max-height: 80vh; }
.yv-header { display: flex; justify-content: space-between; align-items: center; h3 { margin: 0; } }
.yv-close { padding: 0 4px; }
.yv-tabs { display: flex; gap: 4px; margin: 12px 0 0; border-bottom: 1px solid var(--border); }
.yv-tab {
  background: none; border: none; border-bottom: 2px solid transparent; cursor: pointer;
  padding: 6px 12px; color: var(--body-text);
  &.active { border-bottom-color: var(--primary); color: var(--primary); }
}
.yv-hint { margin: 10px 0 0; font-size: 12px; }
// 55vh keeps the footer buttons on screen on a laptop; CodeMirror needs an explicit height to scroll
.yv-body { margin-top: 10px; min-height: 200px; }
.yv-editor { height: 55vh; }
.yv-footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
</style>
