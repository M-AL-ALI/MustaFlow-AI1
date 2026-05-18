import { useListTasks, getListTasksQueryKey } from "@workspace/api-client-react";
import { Terminal, CheckCircle2, Clock, XCircle, AlertCircle } from "lucide-react";

export function LogsTab({ projectId }: { projectId: number }) {
  const { data: tasks } = useListTasks(projectId, {
    query: { enabled: !!projectId, queryKey: getListTasksQueryKey(projectId) },
  });

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'completed': return <CheckCircle2 className="h-4 w-4 text-green-500" />;
      case 'failed': return <XCircle className="h-4 w-4 text-destructive" />;
      case 'building':
      case 'planning':
      case 'testing': return <div className="h-4 w-4 rounded-full border-2 border-primary border-t-transparent animate-spin" />;
      default: return <Clock className="h-4 w-4 text-muted-foreground" />;
    }
  };

  return (
    <div className="p-6 h-full flex flex-col overflow-hidden">
      <h2 className="text-2xl font-bold mb-6">Task Logs</h2>
      
      <div className="flex-1 bg-black rounded-lg border border-border overflow-hidden flex flex-col text-sm font-mono">
        <div className="bg-muted border-b border-border p-2 px-4 flex items-center gap-2 text-muted-foreground">
          <Terminal className="h-4 w-4" /> Activity Stream
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {tasks?.map(task => (
            <div key={task.id} className="flex items-start gap-3">
              <div className="mt-0.5">{getStatusIcon(task.status)}</div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-gray-300 font-semibold">{task.title}</span>
                  <span className="text-gray-500 text-xs">[{task.kind}]</span>
                  <span className="text-gray-600 text-xs">{new Date(task.createdAt).toLocaleTimeString()}</span>
                </div>
                {task.result && (
                  <div className="mt-1 text-gray-400 pl-4 border-l border-gray-800 whitespace-pre-wrap text-xs">
                    {task.result}
                  </div>
                )}
              </div>
            </div>
          ))}
          {(!tasks || tasks.length === 0) && (
            <div className="text-gray-600 text-center py-8">Waiting for tasks to start...</div>
          )}
        </div>
      </div>
    </div>
  );
}