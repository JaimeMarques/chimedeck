// LabelChip — small colored badge displaying a label name.
import type { Label } from '../api';
import Button from '../../../common/components/Button';
import { labelStyle } from '../utils/labelColors';

interface Props {
  label: Label;
  onRemove?: () => void;
}

export const LabelChip = ({ label, onRemove }: Props) => (
  <span
    className="cd-label cd-label-detail inline-flex items-center gap-1 rounded-full pl-3 pr-2 py-0.5 text-xs font-medium"
    style={labelStyle(label.color)}
    title={label.name}
  >
    {label.name}
    {onRemove && (
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="cd-label-remove ml-0.5 rounded-full hover:bg-white/20"
        onClick={onRemove}
        aria-label={`Remove label ${label.name}`}
      >
        ×
      </Button>
    )}
  </span>
);
