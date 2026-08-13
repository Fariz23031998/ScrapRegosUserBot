import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { getChannelSettings, saveChannelSettings } from "../api/tickets";
import EntityCards from "../components/EntityCards";
import LoadingState from "../components/LoadingState";
import { useAuth } from "../hooks/useAuth";
import { COMPACT_LAYOUT_QUERY, useMediaQuery } from "../hooks/useMediaQuery";
import type { ChannelSetting } from "../lib/types";

export default function SettingsPage() {
  const { hasPermission } = useAuth();
  const queryClient = useQueryClient();
  const compact = useMediaQuery(COMPACT_LAYOUT_QUERY);
  const [message, setMessage] = useState<{ text: string; type?: "success" | "error" } | null>(null);
  const [draft, setDraft] = useState<ChannelSetting[]>([]);

  const query = useQuery({
    queryKey: ["channel-settings"],
    queryFn: async () => {
      const data = await getChannelSettings();
      setDraft(data.channels || []);
      return data;
    },
  });

  const saveMutation = useMutation({
    mutationFn: () =>
      saveChannelSettings(
        draft.map((channel) => ({ id: channel.id, interaction_mode: channel.interaction_mode })),
      ),
    onSuccess: (data) => {
      setDraft(data.channels || []);
      setMessage({ text: "Настройки каналов сохранены.", type: "success" });
      void queryClient.invalidateQueries({ queryKey: ["channel-settings"] });
    },
    onError: (error: Error) => setMessage({ text: error.message, type: "error" }),
  });

  const channels = draft.length ? draft : query.data?.channels || [];
  const canEdit = hasPermission("settings_edit");

  function updateMode(channelId: number, value: ChannelSetting["interaction_mode"]) {
    setDraft((prev) =>
      prev.map((item) => (item.id === channelId ? { ...item, interaction_mode: value } : item)),
    );
  }

  function modeSelect(channel: ChannelSetting) {
    return (
      <select
        value={channel.interaction_mode}
        disabled={!canEdit}
        onChange={(event) => {
          updateMode(channel.id, event.target.value as ChannelSetting["interaction_mode"]);
        }}
      >
        <option value="message_only">Только сообщения</option>
        <option value="call">Звонки</option>
      </select>
    );
  }

  return (
    <section className="card">
      {canEdit ? (
        <div className="card-toolbar">
          <button
            type="button"
            className="btn-primary"
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
          >
            Сохранить
          </button>
        </div>
      ) : null}
      {message ? <p className={`message ${message.type || ""}`}>{message.text}</p> : null}
      {query.isLoading ? (
        <LoadingState />
      ) : !channels.length ? (
        <p className="empty-state">Каналы REGOS не найдены.</p>
      ) : compact ? (
        <EntityCards
          items={channels}
          emptyMessage="Каналы REGOS не найдены."
          getKey={(channel) => String(channel.id)}
          getTitle={(channel) => channel.name}
          getSubtitle={(channel) => `ID: ${channel.id}`}
          getFields={(channel) => [
            {
              label: "Статус",
              value: (
                <span className={`badge ${channel.available ? "badge--ok" : "badge--muted"}`}>
                  {channel.available ? (channel.active ? "Активен" : "Неактивен") : "Удалён из REGOS"}
                </span>
              ),
            },
            { label: "Тип взаимодействия", value: modeSelect(channel) },
          ]}
        />
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Канал</th>
                <th>Статус</th>
                <th>Тип взаимодействия</th>
              </tr>
            </thead>
            <tbody>
              {channels.map((channel) => (
                <tr key={channel.id}>
                  <td>
                    <strong>{channel.name}</strong>
                    <br />
                    <small>ID: {channel.id}</small>
                  </td>
                  <td>
                    <span className={`badge ${channel.available ? "badge--ok" : "badge--muted"}`}>
                      {channel.available ? (channel.active ? "Активен" : "Неактивен") : "Удалён из REGOS"}
                    </span>
                  </td>
                  <td>{modeSelect(channel)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
