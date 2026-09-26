// Modal for creating a new board within a workspace.
import { useState } from 'react';
import Button from '~/common/components/Button';

interface Props {
  onClose: () => void;
  onCreate: (title: string) => void;
  /** Optional line under the heading, e.g. the target workspace. */
  subtitle?: string | undefined;
  /** Optional error shown under the input (e.g. a failed create). */
  error?: string | undefined;
}

const CreateBoardModal = ({ onClose, onCreate, subtitle, error }: Props) => {
  const [title, setTitle] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;
    onCreate(trimmed);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-md rounded-lg bg-bg-surface p-6 shadow-xl">
        <h2 className={`${subtitle ? 'mb-1' : 'mb-4'} text-lg font-semibold text-base`}>Create Board</h2>
        {subtitle && <p className="mb-4 text-sm text-muted">{subtitle}</p>}
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <input
            autoFocus
            type="text"
            placeholder="Board title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'create-board-error' : undefined}
            className="rounded border border-border bg-bg-overlay px-3 py-2 text-sm text-base placeholder:text-subtle focus:outline-none focus:ring-2 focus:ring-primary"
          />
          {error && (
            <p id="create-board-error" role="alert" className="-mt-2 text-sm text-danger">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="md" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="md" disabled={!title.trim()}>
              Create
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default CreateBoardModal;
