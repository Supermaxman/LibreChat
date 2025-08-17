import { QueryKeys, dataService, EModelEndpoint, defaultOrderQuery } from 'librechat-data-provider';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryObserverResult, UseQueryOptions } from '@tanstack/react-query';
import type t from 'librechat-data-provider';

/**
 * AGENTS
 */

/**
 * Hook for getting all available tools for A
 */
export const useAvailableAgentToolsQuery = (): QueryObserverResult<t.TPlugin[]> => {
  const queryClient = useQueryClient();
  const endpointsConfig = queryClient.getQueryData<t.TEndpointsConfig>([QueryKeys.endpoints]);

  const enabled = !!endpointsConfig?.[EModelEndpoint.agents];
  return useQuery<t.TPlugin[]>([QueryKeys.tools], () => dataService.getAvailableAgentTools(), {
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    enabled,
  });
};

/**
 * Hook for listing all Agents, with optional parameters provided for pagination and sorting
 */
export const useListAgentsQuery = <TData = t.AgentListResponse>(
  params: t.AgentListParams = defaultOrderQuery,
  config?: UseQueryOptions<t.AgentListResponse, unknown, TData>,
): QueryObserverResult<TData> => {
  const queryClient = useQueryClient();
  const endpointsConfig = queryClient.getQueryData<t.TEndpointsConfig>([QueryKeys.endpoints]);

  const enabled = !!endpointsConfig?.[EModelEndpoint.agents];
  return useQuery<t.AgentListResponse, unknown, TData>(
    [QueryKeys.agents, params],
    () => dataService.listAgents(params),
    {
      // Example selector to sort them by created_at
      // select: (res) => {
      //   return res.data.sort((a, b) => a.created_at - b.created_at);
      // },
      staleTime: 1000 * 5,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      retry: false,
      ...config,
      enabled: config?.enabled !== undefined ? config.enabled && enabled : enabled,
    },
  );
};

/**
 * Hook for retrieving details about a single agent
 */
export const useGetAgentByIdQuery = (
  agent_id: string,
  config?: UseQueryOptions<t.Agent>,
): QueryObserverResult<t.Agent> => {
  return useQuery<t.Agent>(
    [QueryKeys.agent, agent_id],
    () =>
      dataService.getAgentById({
        agent_id,
      }),
    {
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
      retry: false,
      ...config,
    },
  );
};

/**
 * Hook: Agent run status by conversationId
 */
export const useAgentRunStatusQuery = (
  conversationId?: string | null,
  config?: UseQueryOptions<{ running: boolean }>,
): QueryObserverResult<{ running: boolean }> => {
  const enabled = typeof conversationId === 'string' && !!conversationId;
  return useQuery<{ running: boolean }>(
    [QueryKeys.agent, 'runStatus', conversationId],
    () => dataService.getAgentRunStatus(conversationId as string),
    {
      // Poll less frequently, pause when tab is hidden, and stop polling when not running.
      // Add small jitter per convo to de-sync bursts across many icons.
      refetchInterval: (data) => {
        if (document.visibilityState !== 'visible') {
          return false;
        }
        if (!data?.running) {
          return false;
        }
        const id = (conversationId as string) || '';
        let sum = 0;
        for (let i = 0; i < id.length; i++) sum = (sum + id.charCodeAt(i)) % 100000;
        const jitter = sum % 3000; // 0-2999ms
        return 10000 + jitter; // 10-13s
      },
      refetchOnWindowFocus: true,
      refetchIntervalInBackground: false,
      refetchOnReconnect: true,
      retry: false,
      enabled,
      staleTime: 10000,
      ...config,
    },
  );
};
