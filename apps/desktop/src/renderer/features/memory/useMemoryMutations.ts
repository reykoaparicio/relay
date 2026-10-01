// Memory mutations (10 J9). Every success refreshes the project's memory lists, the record details, and the project
// stats (approved / suggestion counts). `memory.create` and `memory.resolveConflict` are idempotent commands and go
// through `useIdempotentMutation` (one key per user intent, 02 §B0).
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { InputOf } from '@relay/contracts';
import { call } from '../../api/client';
import { qk } from '../../api/keys';
import { useIdempotentMutation } from '../../hooks/useIdempotentMutation';
import { isStaleConflict } from '../common/conflict';

function useRefreshMemory(projectId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: ['memory', projectId] });
    void queryClient.invalidateQueries({ queryKey: ['memory-record'] });
    void queryClient.invalidateQueries({ queryKey: qk.project(projectId) });
  };
}

/**
 * The non-idempotent memory commands, each a TanStack mutation that refreshes memory on success. A *stale* CONFLICT
 * (the record changed elsewhere) also refreshes, so the edit form can show the saved version beside the user's edit.
 * A memory_conflict (the result would conflict with another approved record) is not stale: reloading would not help,
 * the page routes it to Combine / Resolve instead.
 */
export function useMemoryMutations(projectId: string) {
  const refresh = useRefreshMemory(projectId);
  const refreshOnConflict = (e: unknown) => {
    if (isStaleConflict(e)) refresh();
  };
  const update = useMutation({
    mutationFn: (input: InputOf<'relay/v1/memory.update'>) => call('relay/v1/memory.update', input),
    onSuccess: refresh,
    onError: refreshOnConflict,
  });
  const approve = useMutation({
    mutationFn: (input: InputOf<'relay/v1/memory.approve'>) => call('relay/v1/memory.approve', input),
    onSuccess: refresh,
    onError: refreshOnConflict,
  });
  const reject = useMutation({
    mutationFn: (input: InputOf<'relay/v1/memory.reject'>) => call('relay/v1/memory.reject', input),
    onSuccess: refresh,
  });
  const archive = useMutation({
    mutationFn: (input: InputOf<'relay/v1/memory.archive'>) => call('relay/v1/memory.archive', input),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (input: InputOf<'relay/v1/memory.delete'>) => call('relay/v1/memory.delete', input),
    onSuccess: refresh,
  });
  return { update, approve, reject, archive, remove };
}

/** `memory.create` (user-authored → approved immediately, §10.1). */
export function useCreateMemory(projectId: string, onCreated?: (id: string) => void) {
  const refresh = useRefreshMemory(projectId);
  return useIdempotentMutation('relay/v1/memory.create', {
    onSuccess: (record) => {
      refresh();
      onCreated?.(record.id);
    },
  });
}

/** `memory.resolveConflict` (keep / rewrite = "Combine" / keep both with scopes). */
export function useResolveConflict(projectId: string, onResolved?: () => void) {
  const refresh = useRefreshMemory(projectId);
  return useIdempotentMutation('relay/v1/memory.resolveConflict', {
    onSuccess: () => {
      refresh();
      onResolved?.();
    },
  });
}
