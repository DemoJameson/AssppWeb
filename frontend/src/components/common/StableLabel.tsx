/**
 * Text that never changes a control's size: both the idle and the busy label
 * are laid out in the same grid cell (one of them invisible), so whichever is
 * on screen the box fits the longer one — swapping text cannot move the
 * layout around it, and the control keeps its shape in every locale.
 */
export default function StableLabel({
  idle,
  busy,
  busyActive,
}: {
  idle: string;
  busy: string;
  busyActive: boolean;
}) {
  return (
    <span className="grid">
      <span aria-hidden="true" className="invisible col-start-1 row-start-1">
        {idle}
      </span>
      <span aria-hidden="true" className="invisible col-start-1 row-start-1">
        {busy}
      </span>
      <span className="col-start-1 row-start-1">{busyActive ? busy : idle}</span>
    </span>
  );
}
