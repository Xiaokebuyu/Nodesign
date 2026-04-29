import { Hammer, ScrollText, FlaskConical, ClipboardList, Inbox } from "lucide-react";

export function SIcon({ s, size = 14, className }) {
  const I = s?.Icon;
  return I ? <I size={size} strokeWidth={1.5} className={className} style={{ verticalAlign: "middle" }} /> : null;
}

const IconMap = { hammer: Hammer, scroll: ScrollText, flask: FlaskConical, clipboard: ClipboardList, inbox: Inbox };

export function DIcon({ name, size = 16 }) {
  const I = IconMap[name];
  return I ? <I size={size} strokeWidth={1.5} /> : name;
}
