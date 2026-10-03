import { Fact } from "../ui/index.js";

/** look.md §5.3: labelled counts, with wrapping values and a 12px column gap. */
export const CountGrid = ({ label, rows }: {
  readonly label: string;
  readonly rows: readonly (readonly [string, string | number])[];
}) => <dl aria-label={label} data-count-grid className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-3 text-xs">
  {rows.map(([name, count]) => <Fact key={name} name={name}>{count}</Fact>)}
</dl>;
