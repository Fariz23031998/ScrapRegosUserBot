import { describe, expect, it } from "vitest";
import type { InfiniteData } from "@tanstack/react-query";
import { buildTicketBoardColumns, resolveActiveBoardColumnId } from "./TicketBoard";
import { moveTicketBetweenBoardColumns, type TicketBoardPage } from "../lib/ticket-board";
import type { Ticket } from "../lib/types";

function ticket(id: number, status: string): Ticket {
  return { id, status, subject: `Ticket ${id}` };
}

function column(
  tickets: Ticket[],
  total = tickets.length,
  active?: Ticket | null,
): InfiniteData<TicketBoardPage> {
  return {
    pages: [{ tickets, total, page: 1, active_ticket: active }],
    pageParams: [1],
  };
}

describe("buildTicketBoardColumns", () => {
  it("shows every status column when the filter is empty", () => {
    const columns = buildTicketBoardColumns(
      {
        Open: [ticket(1, "Open")],
        Closed: [ticket(2, "Closed")],
        WaitingStaff: [ticket(3, "WaitingStaff")],
      },
      [],
    );
    expect(columns.map((column) => column.id)).toEqual([
      "Open",
      "WaitingStaff",
      "WaitingClient",
      "Closed",
    ]);
    expect(columns.find((column) => column.id === "Open")?.tickets.map((item) => item.id)).toEqual([1]);
    expect(columns.find((column) => column.id === "WaitingClient")?.tickets).toEqual([]);
    expect(columns.every((column) => column.droppable)).toBe(true);
  });

  it("keeps only the selected status columns", () => {
    const columns = buildTicketBoardColumns(
      {
        Open: [ticket(1, "Open")],
        WaitingClient: [ticket(2, "WaitingClient")],
      },
      ["WaitingClient", "Open"],
    );
    expect(columns.map((column) => column.id)).toEqual(["Open", "WaitingClient"]);
    expect(columns.map((column) => column.tickets.map((item) => item.id))).toEqual([[1], [2]]);
  });

  it("does not invent a column for a status the board does not load", () => {
    const columns = buildTicketBoardColumns(
      {
        Open: [ticket(1, "Open")],
        Escalated: [ticket(4, "Escalated")],
      },
      [],
    );
    expect(columns.map((column) => column.id)).toEqual([
      "Open",
      "WaitingStaff",
      "WaitingClient",
      "Closed",
    ]);
    expect(columns.every((column) => column.droppable)).toBe(true);
  });
});

describe("resolveActiveBoardColumnId", () => {
  const ids = ["Open", "WaitingStaff", "WaitingClient", "Closed"];

  it("keeps the selected column", () => {
    expect(resolveActiveBoardColumnId(ids, "WaitingClient")).toBe("WaitingClient");
  });

  it("falls back to the first column when nothing is selected", () => {
    expect(resolveActiveBoardColumnId(ids, null)).toBe("Open");
    expect(resolveActiveBoardColumnId(ids, "Missing")).toBe("Open");
  });
});

describe("moveTicketBetweenBoardColumns", () => {
  it("moves a ticket to the top of the target column and adjusts both totals", () => {
    const open = {
      pages: [
        {
          tickets: [ticket(1, "Open"), ticket(2, "Open")],
          total: 3,
          page: 1,
          active_ticket: ticket(1, "Open"),
        },
        { tickets: [ticket(3, "Open")], total: 3, page: 2 },
      ],
      pageParams: [1, 2],
    };
    const closed = column([ticket(4, "Closed")], 1);
    const moved = moveTicketBetweenBoardColumns({ Open: open, Closed: closed }, 2, "Closed");

    expect(moved.Open?.pages[0]?.tickets?.map((item) => item.id)).toEqual([1]);
    expect(moved.Open?.pages[1]?.tickets?.map((item) => item.id)).toEqual([3]);
    expect(moved.Open?.pages.map((page) => page.total)).toEqual([2, 2]);
    expect(moved.Open?.pages[0]?.active_ticket?.status).toBe("Open");
    expect(moved.Closed?.pages[0]?.tickets?.map((item) => [item.id, item.status])).toEqual([
      [2, "Closed"],
      [4, "Closed"],
    ]);
    expect(moved.Closed?.pages[0]?.total).toBe(2);
    expect(moved.Closed?.pageParams).toEqual([1]);
  });

  it("updates the active ticket on every loaded column", () => {
    const open = column([ticket(1, "Open")], 1, ticket(1, "Open"));
    const closed = column([ticket(4, "Closed")], 1, ticket(1, "Open"));
    const moved = moveTicketBetweenBoardColumns({ Open: open, Closed: closed }, 1, "Closed");

    expect(moved.Open?.pages[0]?.active_ticket?.status).toBe("Closed");
    expect(moved.Closed?.pages[0]?.active_ticket?.status).toBe("Closed");
    expect(moved.Closed?.pages[0]?.tickets?.[0]?.id).toBe(1);
    expect(moved.Open?.pages[0]?.total).toBe(0);
    expect(moved.Closed?.pages[0]?.total).toBe(2);
  });

  it("creates a first page when the target column has not loaded", () => {
    const open = column([ticket(7, "Open")], 4);
    const moved = moveTicketBetweenBoardColumns({ Open: open, WaitingStaff: undefined }, 7, "WaitingStaff");

    expect(moved.Open?.pages[0]?.tickets).toEqual([]);
    expect(moved.Open?.pages[0]?.total).toBe(3);
    expect(moved.WaitingStaff?.pages[0]?.tickets?.map((item) => item.id)).toEqual([7]);
    expect(moved.WaitingStaff?.pages[0]?.total).toBe(1);
    expect(moved.WaitingStaff?.pageParams).toEqual([1]);
  });

  it("patches status in place when the ticket is already in that column", () => {
    const open = column([ticket(2, "WaitingStaff")], 1);
    const moved = moveTicketBetweenBoardColumns({ Open: open }, 2, "Open");

    expect(moved.Open?.pages[0]?.tickets?.map((item) => item.status)).toEqual(["Open"]);
    expect(moved.Open?.pages[0]?.total).toBe(1);
    expect(moved.Open?.pages[0]?.tickets).toHaveLength(1);
  });
});
