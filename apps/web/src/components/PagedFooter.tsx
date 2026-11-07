import type { Paged } from '../lib/use-paged';
import { Button, FormMessage } from './ui';

export function PagedFooter({ paged }: { paged: Pick<Paged<unknown>, 'status' | 'hasMore' | 'loadingMore' | 'moreError' | 'loadMore'> }) {
  if (paged.status !== 'ready' || (!paged.hasMore && !paged.moreError)) return null;
  return (
    <div className="flex flex-col items-center gap-2 border-t border-border p-3">
      {paged.moreError && <FormMessage tone="error">{paged.moreError}</FormMessage>}
      {paged.hasMore && (
        <Button variant="secondary" onClick={paged.loadMore} busy={paged.loadingMore}>
          Carregar mais
        </Button>
      )}
    </div>
  );
}
