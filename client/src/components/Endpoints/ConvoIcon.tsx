import React, { useMemo } from 'react';
import type * as t from 'librechat-data-provider';
import { getEndpointField, getIconKey, getEntity, getIconEndpoint } from '~/utils';
import ConvoIconURL from '~/components/Endpoints/ConvoIconURL';
import { icons } from '~/hooks/Endpoint/Icons';


export default function ConvoIcon({
  conversation,
  endpointsConfig,
  assistantMap,
  agentsMap,
  className = '',
  containerClassName = '',
  context,
  size,
  isRunning = false,
}: {
  conversation: t.TConversation | t.TPreset | null;
  endpointsConfig: t.TEndpointsConfig;
  assistantMap: t.TAssistantsMap | undefined;
  agentsMap: t.TAgentsMap | undefined;
  containerClassName?: string;
  context?: 'message' | 'nav' | 'landing' | 'menu-item';
  className?: string;
  size?: number;
  isRunning?: boolean;
}) {
  const iconURL = conversation?.iconURL ?? '';
  let endpoint = conversation?.endpoint;
  endpoint = getIconEndpoint({ endpointsConfig, iconURL, endpoint });

  const { entity, isAgent } = useMemo(
    () =>
      getEntity({
        endpoint,
        agentsMap,
        assistantMap,
        agent_id: conversation?.agent_id,
        assistant_id: conversation?.assistant_id,
      }),
    [endpoint, conversation?.agent_id, conversation?.assistant_id, agentsMap, assistantMap],
  );

  const name = entity?.name ?? '';
  const avatar = isAgent
    ? (entity as t.Agent | undefined)?.avatar?.filepath
    : ((entity as t.Assistant | undefined)?.metadata?.avatar as string);

  const endpointIconURL = getEndpointField(endpointsConfig, endpoint, 'iconURL');
  const iconKey = getIconKey({ endpoint, endpointsConfig, endpointIconURL });
  const Icon = icons[iconKey] ?? null;

  return (
    <>
      {iconURL && iconURL.includes('http') ? (
        <div className={`relative inline-flex ${containerClassName}`}>
          <div className={isRunning ? 'opacity-60 grayscale' : ''}>
            <ConvoIconURL
              iconURL={iconURL}
              modelLabel={conversation?.chatGptLabel ?? conversation?.modelLabel ?? ''}
              endpointIconURL={endpointIconURL}
              assistantAvatar={avatar}
              assistantName={name}
              agentAvatar={avatar}
              agentName={name}
              context={context}
            />
          </div>
          {isRunning && (
            <span className="absolute inset-0 flex items-center justify-center">
              <span className="h-full w-full rounded-full bg-black/10" />
              <span className="absolute h-4 w-4 animate-spin rounded-full border-2 border-white/80 border-t-transparent" />
            </span>
          )}
        </div>
      ) : (
        <div className={`relative inline-flex ${containerClassName}`}>
          <div className={isRunning ? 'opacity-60 grayscale' : ''}>
            {endpoint && Icon != null && (
              <Icon
                size={size}
                context={context}
                endpoint={endpoint}
                className={className}
                iconURL={endpointIconURL}
                assistantName={name}
                agentName={name}
                avatar={avatar}
              />
            )}
          </div>
          {isRunning && (
            <span className="absolute inset-0 flex items-center justify-center">
              <span className="h-full w-full rounded-full bg-black/10" />
              <span className="absolute h-4 w-4 animate-spin rounded-full border-2 border-white/80 border-t-transparent" />
            </span>
          )}
        </div>
      )}
    </>
  );
}
