import { Select } from "@/components/field";
import { HOURS, MINUTES, PERIODS, toClockTime } from "@/server/modules/tutoring/clock-rules";

export function TimePicker({
  label,
  name,
  defaultMinute,
}: {
  label: string;
  name: "start" | "end";
  defaultMinute: number;
}) {
  const time = toClockTime(defaultMinute);

  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="pb-1.5 text-sm font-medium text-foreground">{label}</legend>
      <div className="grid grid-cols-3 gap-2">
        <Select aria-label={`${label} hour`} name={`${name}Hour`} defaultValue={time.hour}>
          {HOURS.map((hour) => (
            <option key={hour} value={hour}>
              {hour}
            </option>
          ))}
        </Select>
        <Select aria-label={`${label} minute`} name={`${name}Minute`} defaultValue={time.minute}>
          {MINUTES.map((minute) => (
            <option key={minute} value={minute}>
              {String(minute).padStart(2, "0")}
            </option>
          ))}
        </Select>
        <Select aria-label={`${label} AM or PM`} name={`${name}Period`} defaultValue={time.period}>
          {PERIODS.map((period) => (
            <option key={period} value={period}>
              {period}
            </option>
          ))}
        </Select>
      </div>
    </fieldset>
  );
}
