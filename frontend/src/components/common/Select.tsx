import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  /** Optional section header rendered above the first option of each group. */
  group?: string;
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
 * The app's dropdown: a styled popover standing in for the native <select>,
 * so the menu follows the app's design instead of the OS. The trigger keeps
 * the combobox role — assistive tech (and the test suite) treat it like the
 * control it replaces — and the full keyboard pattern works on it: Enter/
 * Space or ArrowDown/ArrowUp opens the menu, Arrow keys move the highlight
 * (Home/End jump to the ends), Enter picks, Escape or an outside click closes
 * and returns focus. The menu inherits the trigger's computed font size so
 * list and field always read at the same size.
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
  const optionRefs = useRef<(HTMLLIElement | null)[]>([]);
  const listboxId = useId();

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  // Keep the highlighted option in view while the keyboard moves through it.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    optionRefs.current[activeIndex]?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeIndex]);

  const selected = options.find((option) => option.value === value);

  function openMenu(preferLast: boolean) {
    let index = options.findIndex((option) => option.value === value);
    // Nothing matches the value (an empty selection): leave the list
    // unhighlighted so no option wears the focus tint before the user points
    // at one. ArrowUp still opens at the last option, and the first arrow key
    // picks up from the right end.
    if (index < 0) index = preferLast ? options.length - 1 : -1;
    setActiveIndex(index);
    // The menu mirrors the trigger's real rendered font size.
    if (triggerRef.current) {
      const size = window.getComputedStyle(triggerRef.current).fontSize;
      if (size) setMenuFontSize(size);
    }
    setOpen(true);
  }

  function applyOption(option: SelectOption) {
    if (option.disabled) return;
    onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  }

  function closeMenu() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    const { key } = event;

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
        setActiveIndex((current) => Math.min(current + 1, options.length - 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setActiveIndex((current) => Math.max(current - 1, 0));
        break;
      case "Home":
        event.preventDefault();
        setActiveIndex(0);
        break;
      case "End":
        event.preventDefault();
        setActiveIndex(Math.max(options.length - 1, 0));
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
      case "Tab":
        setOpen(false);
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
        <ul
          id={listboxId}
          role="listbox"
          aria-label={ariaLabel}
          style={menuFontSize ? { fontSize: menuFontSize } : undefined}
          className="absolute left-0 right-0 z-[60] mt-1 max-h-72 overflow-y-auto rounded-xl border border-black/10 bg-white py-1 text-sm shadow-lg dark:border-white/10 dark:bg-gray-800"
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
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => applyOption(option)}
                  className={`cursor-pointer truncate px-3 py-2 transition-colors ${
                    option.value === value
                      ? "bg-blue-50 font-medium text-blue-700 dark:bg-blue-950/50 dark:text-blue-300"
                      : `text-gray-700 dark:text-gray-200 ${
                          active
                            ? "bg-gray-100 dark:bg-gray-700"
                            : "hover:bg-gray-100 dark:hover:bg-gray-700"
                        }`
                  } ${option.disabled ? "cursor-not-allowed opacity-50" : ""}`}
                >
                  {option.label}
                </li>
              </Fragment>
            );
          })}
        </ul>
      )}
    </div>
  );
}
