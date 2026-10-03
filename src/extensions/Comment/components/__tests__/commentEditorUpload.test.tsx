// Run this regression by itself with `bun test src/extensions/Comment/components/__tests__/commentEditorUpload.test.tsx`.
// [why] It mounts the real editor and upload hook in jsdom so the immediate-submit race stays isolated from other DOM suites.
import { afterEach, describe, expect, it } from 'bun:test';
import { JSDOM } from 'jsdom';
import type { Attachment } from '~/extensions/Attachments/types';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://chimedeck.test/board/board-1/card/card-1',
  pretendToBeVisual: true,
});
const jsdomWindow = dom.window;
Object.defineProperty(jsdomWindow.document, 'elementFromPoint', {
  value: () => jsdomWindow.document.querySelector('.ProseMirror'),
  configurable: true,
});

for (const key of [
  'window', 'document', 'location', 'navigator', 'DOMParser', 'Node', 'NodeFilter', 'Element',
  'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLImageElement', 'DocumentFragment',
  'Text', 'Event', 'CustomEvent', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
] as const) {
  const value = key === 'window' ? jsdomWindow : (jsdomWindow as unknown as Record<string, unknown>)[key];
  Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
}
Object.defineProperty(globalThis, 'ResizeObserver', {
  value: class { observe() {} disconnect() {} unobserve() {} },
  writable: true,
  configurable: true,
});

const React = (await import('react')).default;
const { configureStore } = await import('@reduxjs/toolkit');
const { Provider } = await import('react-redux');
const { cleanup, fireEvent, render, waitFor } = await import('@testing-library/react');
const { authReducer } = await import('~/slices/authSlice');
const { workspaceShellReducer } = await import('~/extensions/Workspace/duck/workspaceDuck');
const { default: apiClient } = await import('~/common/api/client');
const { messageQueue } = await import('~/extensions/Realtime/client/messageQueue');
const { default: CommentEditor } = await import('../CommentEditor');

const UPLOADED_IDS = [
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
] as const;
const EXISTING_ID = '20000000-0000-4000-8000-000000000001';

function makeAttachment(id: string, uploadContext: 'card' | 'comment'): Attachment {
  return {
    id,
    card_id: 'card-1',
    name: 'image.png',
    alias: null,
    type: 'FILE',
    status: 'READY',
    key: `comments/${id}/image.png`,
    thumbnail_key: null,
    content_type: 'image/png',
    size_bytes: 5,
    width: 1,
    height: 1,
    view_url: `/api/v1/attachments/${id}/view`,
    thumbnail_url: null,
    external_url: null,
    referenced_card_id: null,
    referenced_card: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    upload_context: uploadContext,
  };
}

class TestXMLHttpRequest {
  upload = { onprogress: null as ((event: ProgressEvent) => void) | null };
  status = 0;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  open() {}
  setRequestHeader() {}
  send() {
    this.status = 200;
    queueMicrotask(() => this.onload?.());
  }
}

function makeStore() {
  return configureStore({
    reducer: {
      auth: authReducer,
      workspaceShell: workspaceShellReducer,
    },
    preloadedState: {
      auth: { user: { id: 'user-1', name: 'Reader', email: 'reader@example.com' }, accessToken: 'token', status: 'authenticated' as const },
      workspaceShell: {
        workspaces: [], activeWorkspaceId: 'workspace-1', status: 'idle' as const,
        createInProgress: false, createError: null,
      },
    },
  });
}

function mountEditor(
  onSubmit: (content: string) => Promise<void>,
  existing: Attachment[],
  initialValue = 'Photo:',
) {
  return render(
    <Provider store={makeStore()}>
      <CommentEditor
        boardId="board-1"
        cardId="card-1"
        availableAttachments={existing}
        initialValue={initialValue}
        onSubmit={onSubmit}
      />
    </Provider>,
  );
}

afterEach(() => {
  cleanup();
  messageQueue.clear();
});

describe('CommentEditor dropped image submission', () => {
  it('keeps an offline queued image available and prevents posting text without it', async () => {
    const originalAdapter = apiClient.defaults.adapter;
    const originalXhr = globalThis.XMLHttpRequest;
    const originalOnLine = Object.getOwnPropertyDescriptor(jsdomWindow.navigator, 'onLine');
    let uploadRequested = false;
    const existing = makeAttachment(EXISTING_ID, 'card');
    apiClient.defaults.adapter = async (config) => {
      await Promise.resolve();
      const url = config.url ?? '';
      if (config.method === 'get' && url.includes('/attachments')) {
        return { data: { data: [existing] }, status: 200, statusText: 'OK', headers: {}, config };
      }
      if (url.includes('/attachments/upload-url')) uploadRequested = true;
      throw new Error(`Unexpected request while offline: ${config.method ?? 'get'} ${url}`);
    };
    globalThis.XMLHttpRequest = TestXMLHttpRequest as unknown as typeof XMLHttpRequest;

    try {
      Object.defineProperty(jsdomWindow.navigator, 'onLine', { configurable: true, value: false });
      const posted: string[] = [];
      const editor = mountEditor((content) => {
        posted.push(content);
        return Promise.resolve();
      }, [existing]);
      await waitFor(() => {
        expect(editor.container.querySelector('.ProseMirror')).not.toBeNull();
      });
      const proseMirror = editor.container.querySelector('.ProseMirror');
      if (!proseMirror) throw new Error('Comment editor did not mount');

      const file = new File(['image'], 'image.png', { type: 'image/png' });
      fireEvent.drop(proseMirror, {
        clientX: 1,
        clientY: 1,
        dataTransfer: { files: [file], getData: () => '' },
      });
      fireEvent.click(editor.getByRole('button', { name: 'Save' }));

      await waitFor(() => {
        expect(editor.getByText('Connect to finish uploading files before posting this comment.')).toBeTruthy();
      });
      expect(posted).toEqual([]);
      expect(messageQueue.getAll()).toHaveLength(0);
      expect(uploadRequested).toBe(false);
      expect(editor.getByTestId('inline-upload-preview').textContent).toContain('image.png');
      expect(editor.getByTestId('inline-upload-preview').textContent).toContain('Queued');
    } finally {
      cleanup();
      messageQueue.clear();
      if (originalAdapter === undefined) delete apiClient.defaults.adapter;
      else apiClient.defaults.adapter = originalAdapter;
      globalThis.XMLHttpRequest = originalXhr;
      if (originalOnLine) Object.defineProperty(jsdomWindow.navigator, 'onLine', originalOnLine);
      else delete (jsdomWindow.navigator as { onLine?: boolean }).onLine;
    }
  });

  it('submits an image-only drop after flushing its queued upload', async () => {
    const originalAdapter = apiClient.defaults.adapter;
    const originalXhr = globalThis.XMLHttpRequest;
    let uploadRequested = false;
    const existing = makeAttachment(EXISTING_ID, 'card');
    const uploaded = makeAttachment(UPLOADED_IDS[0], 'comment');
    apiClient.defaults.adapter = async (config) => {
      await Promise.resolve();
      const url = config.url ?? '';
      if (url.includes('/attachments/upload-url')) {
        uploadRequested = true;
        return {
          data: { data: { attachmentId: UPLOADED_IDS[0], uploadUrl: 'https://storage.test/upload', key: 'comments/image.png' } },
          status: 200, statusText: 'OK', headers: {}, config,
        };
      }
      if (config.method === 'post' && /\/attachments$/.test(url)) {
        return { data: { data: uploaded }, status: 200, statusText: 'OK', headers: {}, config };
      }
      if (config.method === 'get' && url.includes('/attachments')) {
        return { data: { data: [existing] }, status: 200, statusText: 'OK', headers: {}, config };
      }
      throw new Error(`Unexpected attachment request: ${config.method ?? 'get'} ${url}`);
    };
    globalThis.XMLHttpRequest = TestXMLHttpRequest as unknown as typeof XMLHttpRequest;

    try {
      Object.defineProperty(jsdomWindow.navigator, 'onLine', { configurable: true, value: true });
      const posted: string[] = [];
      const editor = mountEditor((content) => {
        posted.push(content);
        return Promise.resolve();
      }, [existing], '');
      await waitFor(() => {
        expect(editor.container.querySelector('.ProseMirror')).not.toBeNull();
      });
      const proseMirror = editor.container.querySelector('.ProseMirror');
      if (!proseMirror) throw new Error('Comment editor did not mount');

      const file = new File(['image'], 'image.png', { type: 'image/png' });
      fireEvent.drop(proseMirror, {
        clientX: 1,
        clientY: 1,
        dataTransfer: { files: [file], getData: () => '' },
      });
      fireEvent.click(editor.getByRole('button', { name: 'Save' }));

      await waitFor(() => {
        expect(posted).toHaveLength(1);
      });
      expect(uploadRequested).toBe(true);
      expect(posted[0]).toContain(`attachment:id:${UPLOADED_IDS[0]}`);
      expect(posted[0]).not.toContain('attachment:image.png');
      expect(posted[0]).not.toContain('/api/v1/attachments/');
    } finally {
      cleanup();
      if (originalAdapter === undefined) delete apiClient.defaults.adapter;
      else apiClient.defaults.adapter = originalAdapter;
      globalThis.XMLHttpRequest = originalXhr;
    }
  });

  it('uses the uploaded attachment ID for immediate online submits and offline drafts with duplicate names', async () => {
    const originalAdapter = apiClient.defaults.adapter;
    const originalXhr = globalThis.XMLHttpRequest;
    const originalOnLine = Object.getOwnPropertyDescriptor(jsdomWindow.navigator, 'onLine');
    let uploadIndex = 0;
    const existing = makeAttachment(EXISTING_ID, 'card');
    const getUploadedId = (index: number) => {
      const id = UPLOADED_IDS[Math.min(index - 1, UPLOADED_IDS.length - 1)];
      if (!id) throw new Error('Missing upload ID');
      return id;
    };
    const uploaded = () => makeAttachment(getUploadedId(uploadIndex), 'comment');
    apiClient.defaults.adapter = async (config) => {
      await Promise.resolve();
      const url = config.url ?? '';
      if (url.includes('/attachments/upload-url')) {
        uploadIndex++;
        return {
          data: { data: { attachmentId: getUploadedId(uploadIndex), uploadUrl: 'https://storage.test/upload', key: 'comments/image.png' } },
          status: 200, statusText: 'OK', headers: {}, config,
        };
      }
      if (config.method === 'post' && /\/attachments$/.test(url)) {
        return { data: { data: uploaded() }, status: 200, statusText: 'OK', headers: {}, config };
      }
      if (config.method === 'get' && url.includes('/attachments')) {
        return { data: { data: [existing] }, status: 200, statusText: 'OK', headers: {}, config };
      }
      throw new Error(`Unexpected attachment request: ${config.method ?? 'get'} ${url}`);
    };
    globalThis.XMLHttpRequest = TestXMLHttpRequest as unknown as typeof XMLHttpRequest;

    try {
      const posted: string[] = [];
      Object.defineProperty(jsdomWindow.navigator, 'onLine', { configurable: true, value: true });
      const online = mountEditor((content) => {
        posted.push(content);
        return Promise.resolve();
      }, [existing]);
      await waitFor(() => {
        expect(online.container.querySelector('.ProseMirror')).not.toBeNull();
      });
      const proseMirror = online.container.querySelector('.ProseMirror');
      if (!proseMirror) throw new Error('Comment editor did not mount');
      const file = new File(['image'], 'image.png', { type: 'image/png' });
      fireEvent.drop(proseMirror, {
        clientX: 1,
        clientY: 1,
        dataTransfer: { files: [file], getData: () => '' },
      });
      fireEvent.click(online.getByRole('button', { name: 'Save' }));

      await waitFor(() => {
        expect(posted).toHaveLength(1);
      });
      expect(posted[0]).toContain(`attachment:id:${UPLOADED_IDS[0]}`);
      expect(posted[0]).not.toContain('attachment:image.png');
      expect(posted[0]).not.toContain('/api/v1/attachments/');
      online.unmount();

      Object.defineProperty(jsdomWindow.navigator, 'onLine', { configurable: true, value: true });
      const offline = mountEditor(() => Promise.resolve(), [existing]);
      await waitFor(() => {
        expect(offline.container.querySelector('.ProseMirror')).not.toBeNull();
      });
      fireEvent.change(offline.getByTestId('comment-attachment-input'), { target: { files: [file] } });
      await waitFor(() => {
        expect(offline.container.querySelector('img')?.getAttribute('src')).toBe(
          `/api/v1/attachments/${UPLOADED_IDS[1]}/view`,
        );
      });
      Object.defineProperty(jsdomWindow.navigator, 'onLine', { configurable: true, value: false });
      expect(navigator.onLine).toBe(false);
      fireEvent.click(offline.getByRole('button', { name: 'Save' }));

      await waitFor(() => {
        expect(messageQueue.getAll()).toHaveLength(1);
      });
      const draft = messageQueue.getAll()[0]?.body as { content: string };
      expect(draft.content).toContain(`attachment:id:${UPLOADED_IDS[1]}`);
      expect(draft.content).not.toContain('attachment:image.png');
      expect(draft.content).not.toContain('/api/v1/attachments/');
    } finally {
      cleanup();
      messageQueue.clear();
      if (originalAdapter === undefined) delete apiClient.defaults.adapter;
      else apiClient.defaults.adapter = originalAdapter;
      globalThis.XMLHttpRequest = originalXhr;
      if (originalOnLine) Object.defineProperty(jsdomWindow.navigator, 'onLine', originalOnLine);
      else delete (jsdomWindow.navigator as { onLine?: boolean }).onLine;
    }
  });
});
