import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  /** Optional section header rendered above the first option of each group. */
  group?: string;
  /**
   * Optional non-interactive status at the row's end (e.g. a 已下载 badge).
   * Interactive actions belong in `action`, outside the listbox.
   */
  trailing?: ReactNode;
  /** Optional action rendered outside the listbox, so it stays keyboard-accessible. */
  action?: {
    label: string;
    onActivate: () => void;
  };
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  disabled?: boolean;
  id?: string;
  ariaLabel?: string;
  /** Shown when `value` matches no option — an empty selection. */
  placeholder?: string;
  /** Styling for the trigger button (background, padding, radius, ...). */
  className?: string;
  /** Layout styling for the wrapper (e.g. widths inside flex rows). */
  wrapperClassName?: string;
}

/**
 * The app's dropdown: a styled popover in place of the native <select>. The
 * trigger keeps the combobox role and the full keyboard pattern (arrows,
 * Home/End, Enter, Escape). The menu inherits the trigger's computed font size.
 */
export default function Select({
  value,
  onChange,
  options,
  disabled,
  id,
  ariaLabel,
  placeholder,
  className = "",
  wrapperClassName = "",
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [menuFontSize, setMenuFontSize] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<(HTMLElement | null)[]>([]);
  const pointerDownInsideRef = useRef(false);
  const typeaheadRef = useRef<{
    query: string;
    timer: ReturnType<typeof setTimeout> | undefined;
    lastAt: number;
  }>({ query: "", timer: undefined, lastAt: 0 });
  const listboxId = useId();

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      const inside = !!rootRef.current?.contains(target);
      pointerDownInsideRef.current = inside;
      if (!inside) {
        setOpen(false);
        resetTypeahead();
      }
    };
    const onPointerUp = (event: PointerEvent) => {
      const target = event.target as Node;
      if (rootRef.current && !rootRef.current.contains(target)) {
        setOpen(false);
        resetTypeahead();
      }
      pointerDownInsideRef.current = false;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || target === document.body) return;
      if (
        !pointerDownInsideRef.current &&
        rootRef.current &&
        !rootRef.current.contains(target)
      ) {
        setOpen(false);
        resetTypeahead();
      }
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("pointerup", onPointerUp);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("pointerup", onPointerUp);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    return () => {
      if (typeaheadRef.current.timer) {
        clearTimeout(typeaheadRef.current.timer);
      }
    };
  }, []);

  // Keep the highlighted option in view while the keyboard moves through it.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    optionRefs.current[activeIndex]?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeIndex]);

  const selected = options.find((option) => option.value === value);
  const actionOptions = options.flatMap((option) =>
    option.action ? [{ option, action: option.action }] : [],
  );

  function openMenu(preferLast: boolean) {
    let index = options.findIndex((option) => option.value === value);
    // Nothing matches the value (empty selection): leave the list unhighlighted.
    // ArrowUp still opens at the last option.
    if (index < 0) index = preferLast ? options.length - 1 : -1;
    setActiveIndex(index);
    // The menu mirrors the trigger's real rendered font size.
    if (triggerRef.current) {
      const size = window.getComputedStyle(triggerRef.current).fontSize;
      if (size) setMenuFontSize(size);
    }
    setOpen(true);
  }

  function resetTypeahead() {
    const state = typeaheadRef.current;
    state.query = "";
    state.lastAt = 0;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
  }

  function applyOption(option: SelectOption) {
    if (option.disabled) return;
    onChange(option.value);
    resetTypeahead();
    setOpen(false);
    triggerRef.current?.focus();
  }

  function closeMenu() {
    resetTypeahead();
    setOpen(false);
    triggerRef.current?.focus();
  }

  function activateAction(action: NonNullable<SelectOption["action"]>) {
    resetTypeahead();
    setOpen(false);
    triggerRef.current?.focus();
    action.onActivate();
  }

  function nextEnabledIndex(from: number, direction: 1 | -1): number {
    if (options.length === 0) return -1;
    for (let step = 1; step <= options.length; step += 1) {
      const index =
        (from + direction * step + options.length * options.length) %
        options.length;
      if (!options[index]?.disabled) return index;
    }
    return from >= 0 && from < options.length && !options[from]?.disabled
      ? from
      : -1;
  }

  function firstEnabledIndex(direction: 1 | -1): number {
    return direction === 1
      ? nextEnabledIndex(-1, 1)
      : nextEnabledIndex(options.length, -1);
  }

  function typeaheadIndex(query: string, from: number): number {
    if (!query) return -1;
    const needle = query.toLocaleLowerCase();
    for (let step = 1; step <= options.length; step += 1) {
      const index = (from + step + options.length) % options.length;
      const option = options[index];
      if (
        option &&
        !option.disabled &&
        option.label.toLocaleLowerCase().startsWith(needle)
      ) {
        return index;
      }
    }
    return -1;
  }

  function handleTypeahead(key: string): boolean {
    const state = typeaheadRef.current;
    const now = Date.now();
    if (now - state.lastAt > 800) state.query = "";
    state.query += key;
    state.lastAt = now;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      state.query = "";
      state.lastAt = 0;
    }, 800);

    const selectedIndex = options.findIndex(
      (option) => option.value === value,
    );
    const from = open && activeIndex >= 0 ? activeIndex : selectedIndex;
    const match = typeaheadIndex(state.query, from);
    if (match < 0) return false;

    if (!open) openMenu(false);
    setActiveIndex(match);
    return true;
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    const { key } = event;

    const isPrintable =
      key.length === 1 &&
      key !== " " &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.nativeEvent.isComposing;
    if (isPrintable) {
      event.preventDefault();
      handleTypeahead(key);
      return;
    }

    if (!open) {
      if (key === "ArrowDown" || key === "ArrowUp") {
        event.preventDefault();
        openMenu(key === "ArrowUp");
      }
      return;
    }

    switch (key) {
      case "ArrowDown":
        event.preventDefault();
        setActiveIndex((current) =>
          nextEnabledIndex(current < 0 ? -1 : current, 1),
        );
        break;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((current) =>
          nextEnabledIndex(
            current < 0 ? options.length : current,
            -1,
          ),
        );
        break;
      case "Home":
        event.preventDefault();
        setActiveIndex(firstEnabledIndex(1));
        break;
      case "End":
        event.preventDefault();
        setActiveIndex(firstEnabledIndex(-1));
        break;
      case "Enter":
      case " ": {
        event.preventDefault();
        const option = options[activeIndex];
        if (option) applyOption(option);
        break;
      }
      case "Escape":
        event.preventDefault();
        closeMenu();
        break;
    }
  }

  return (
    <div ref={rootRef} className={`relative min-w-0 ${wrapperClassName}`}>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={
          open && activeIndex >= 0
            ? `${listboxId}-opt-${activeIndex}`
            : undefined
        }
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => {
          if (open) {
            setOpen(false);
          } else {
            openMenu(false);
          }
        }}
        onKeyDown={handleKeyDown}
        title={selected?.label ?? placeholder ?? value}
        className={`flex items-center justify-between gap-2 text-left ${className}`}
      >
        <span className="min-w-0 flex-1 truncate">
          {selected?.label ?? placeholder ?? value}
        </span>
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={`h-4 w-4 shrink-0 text-gray-400 transition-transform dark:text-gray-500 ${
            open ? "rotate-180" : ""
          }`}
        >
          <path d="M4 6.5 8 10.5l4-4" />
        </svg>
      </button>

      {open && (
        <div
          style={menuFontSize ? { fontSize: menuFontSize } : undefined}
          className="absolute left-0 right-0 z-[60] mt-1 overflow-hidden rounded-xl border border-black/10 bg-white text-sm shadow-lg dark:border-white/10 dark:bg-gray-800"
        >
          <ul
            id={listboxId}
            role="listbox"
            aria-label={ariaLabel}
            className="max-h-72 overflow-y-auto py-1"
            onMouseDown={(event) => {
              if ((event.target as HTMLElement).closest('[role="option"]')) {
                event.preventDefault();
              }
            }}
          >
            {options.map((option, index) => {
              const groupHeader =
                option.group && options[index - 1]?.group !== option.group
                  ? option.group
                  : null;
              const active = index === activeIndex;

              return (
                <Fragment key={`${option.group ?? ""}-${option.value}-${index}`}>
                  {groupHeader && (
                    <li
                      role="presentation"
                      className="px-3 pb-1 pt-2 text-xs font-medium text-gray-400 dark:text-gray-500"
                    >
                      {groupHeader}
                    </li>
                  )}
                  <li
                    id={`${listboxId}-opt-${index}`}
                    ref={(node) => {
                      optionRefs.current[index] = node;
                    }}
                    role="option"
                    aria-selected={option.value === value}
                    aria-disabled={option.disabled || undefined}
                    title={option.label}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => applyOption(option)}
                    className={`flex min-w-0 items-center gap-2 px-3 py-2 transition-colors ${
                      option.disabled ? "cursor-not-allowed" : "cursor-pointer"
                    } ${
                      option.value === value
                        ? "bg-blue-50 font-medium text-blue-700 dark:bg-blue-950/50 dark:text-blue-300"
                        : `text-gray-700 dark:text-gray-200 ${
                            active
                              ? "bg-gray-100 dark:bg-gray-700"
                              : "hover:bg-gray-100 dark:hover:bg-gray-700"
                          }`
                    }`}
                  >
                    {/* Dimming sits on the label alone — a parent opacity cannot
                        be undone, and the trailing mark must stay readable. */}
                    <span
                      className={`min-w-0 flex-1 truncate ${
                        option.disabled ? "opacity-50" : ""
                      }`}
                    >
                      {option.label}
                    </span>
                    {option.trailing ? (
                      <span className="shrink-0">{option.trailing}</span>
                    ) : null}
                  </li>
                </Fragment>
              );
            })}
          </ul>
          {actionOptions.length > 0 && (
            <div className="max-h-32 overflow-y-auto border-t border-black/10 p-2 dark:border-white/10">
              {actionOptions.map(({ option, action }) => (
                <button
                  key={`${option.value}-action`}
                  type="button"
                  onClick={() => activateAction(action)}
                  aria-label={`${action.label}: ${option.label}`}
                  className="flex min-h-9 w-full min-w-0 items-center justify-between gap-2 rounded-lg bg-blue-50 px-2.5 py-1.5 text-left text-xs font-medium text-blue-700 transition-colors hover:bg-blue-100 dark:bg-blue-950/50 dark:text-blue-300 dark:hover:bg-blue-900/60"
                >
                  <span className="truncate">{action.label}</span>
                  <span className="min-w-0 max-w-[60%] truncate text-blue-500/80 dark:text-blue-400/80">
                    {option.label}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
