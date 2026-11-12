// The board: what `ticket.sh <project> ls` printed, sorted into columns.
export const COLUMNS = [
  { title: "To do", stages: ["todo"] },
  { title: "In progress", stages: ["doing", "blocked"] },
  { title: "Review", stages: ["review"] },
  { title: "Done", stages: ["done"] },
];

export function parseTickets(text) {
  return text.split("\n").filter(Boolean).map((line) => {
    const [id, stage, owner, at, title] = line.split("\t");
    return { id, stage, owner, at: Number(at), title };
  });
}

// Most recently changed first, so what just moved is at the top.
export const inColumn = (tickets, column) => tickets.filter((x) => column.stages.includes(x.stage)).sort((a, b) => b.at - a.at);
