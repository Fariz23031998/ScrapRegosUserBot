import { Bot, Menu } from "lucide-react";
import { useState } from "react";
import { useAdminShell } from "../lib/admin-shell";
import OpsAgentModal from "./OpsAgentModal";

export default function OpsAgentFab() {
  const { toggleNav } = useAdminShell();
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className="tickets-fab-dock ops-agent-fab">
        <button
          type="button"
          className="tickets-fab tickets-fab--nav"
          aria-label="Меню"
          title="Меню"
          onClick={toggleNav}
        >
          <Menu size={22} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="tickets-fab"
          aria-label="Агент задач"
          title="Агент задач"
          onClick={() => setOpen(true)}
        >
          <Bot size={22} aria-hidden="true" />
        </button>
      </div>
      <OpsAgentModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}
