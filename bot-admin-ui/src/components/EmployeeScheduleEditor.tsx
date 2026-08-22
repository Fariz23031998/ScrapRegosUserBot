import type { ScheduleEditorDay } from "../lib/employee-schedule";

export default function EmployeeScheduleEditor({
  days,
  onChange,
}: {
  days: ScheduleEditorDay[];
  onChange: (days: ScheduleEditorDay[]) => void;
}) {
  function updateDay(key: ScheduleEditorDay["key"], patch: Partial<ScheduleEditorDay>) {
    onChange(days.map((day) => (day.key === key ? { ...day, ...patch } : day)));
  }

  return (
    <fieldset className="schedule-editor">
      <legend>График работы</legend>
      <div className="schedule-editor__rows">
        {days.map((day) => (
          <div key={day.key} className="schedule-editor__row">
            <label className="field-checkbox">
              <input
                type="checkbox"
                checked={day.enabled}
                onChange={(event) => updateDay(day.key, { enabled: event.target.checked })}
              />
              <span>{day.label}</span>
            </label>
            {day.enabled ? (
              <>
                <input
                  type="time"
                  value={day.start}
                  onChange={(event) => updateDay(day.key, { start: event.target.value })}
                  aria-label={`${day.label} начало`}
                />
                <input
                  type="time"
                  value={day.end}
                  onChange={(event) => updateDay(day.key, { end: event.target.value })}
                  aria-label={`${day.label} окончание`}
                />
              </>
            ) : (
              <span className="schedule-editor__off">Выходной</span>
            )}
          </div>
        ))}
      </div>
    </fieldset>
  );
}
