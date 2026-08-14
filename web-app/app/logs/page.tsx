import Link from "next/link";

import LogsViewer from "../components/LogsViewer";

export default function Logs() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-black/10 px-4 py-3 dark:border-white/10">
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          <Link href="/" className="font-medium underline underline-offset-2">
            Ask your data
          </Link>
          {" · "}
          <Link href="/simulate" className="font-medium underline underline-offset-2">
            Simulate events
          </Link>
        </p>
      </div>
      <LogsViewer />
    </div>
  );
}
