import { useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { testAiGroupTopic } from "../api/ai";
import type { AiGroupTopic } from "../lib/types";
import Modal from "./Modal";

const DEFAULT_TEST_MESSAGE = "Тестовое сообщение из настроек AI.";

type GroupTopicTestModalProps = {
  open: boolean;
  topics: AiGroupTopic[];
  onClose: () => void;
};

export default function GroupTopicTestModal({ open, topics, onClose }: GroupTopicTestModalProps) {
  const [topicKey, setTopicKey] = useState("");
  const [text, setText] = useState(DEFAULT_TEST_MESSAGE);
  const [result, setResult] = useState<{ text: string; type: "success" | "error" } | null>(null);

  useEffect(() => {
    if (!open) return;
    setTopicKey(String(topics[0]?.key || ""));
    setText(DEFAULT_TEST_MESSAGE);
    setResult(null);
    // Reset only when the modal opens, not when the parent re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- topics captured at open
  }, [open]);

  const sendMutation = useMutation({
    mutationFn: () => testAiGroupTopic({ topic_key: topicKey, message: text }),
    onSuccess: (data) => {
      setResult({
        text: `Отправлено в «${data.topic_name || data.topic_key}».`,
        type: "success",
      });
    },
    onError: (error: Error) => setResult({ text: error.message, type: "error" }),
  });

  return (
    <Modal title="Проверка темы группы" open={open} onClose={onClose}>
      <form
        className="stack-form"
        onSubmit={(event) => {
          event.preventDefault();
          sendMutation.mutate();
        }}
      >
        <p className="muted-copy">
          Сообщение уйдёт в Telegram по сохранённым настройкам. Сначала нажмите «Сохранить», если меняли список тем.
        </p>
        <label>
          Тема
          <select
            value={topicKey}
            onChange={(event) => setTopicKey(event.target.value)}
            disabled={!topics.length || sendMutation.isPending}
          >
            {topics.length ? (
              topics.map((topic) => (
                <option key={String(topic.key)} value={topic.key}>
                  {topic.name || topic.key} ({topic.key})
                </option>
              ))
            ) : (
              <option value="">Нет сохранённых тем</option>
            )}
          </select>
        </label>
        <label>
          Сообщение
          <textarea
            rows={4}
            value={text}
            disabled={sendMutation.isPending}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        {result ? <p className={`message ${result.type}`}>{result.text}</p> : null}
        <div className="form-actions">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Закрыть
          </button>
          <button
            type="submit"
            className="btn-primary"
            disabled={sendMutation.isPending || !topicKey || !text.trim()}
          >
            {sendMutation.isPending ? "Отправка…" : "Отправить"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
