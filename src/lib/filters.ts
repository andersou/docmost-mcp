/**
 * Filter functions to extract only relevant information from API responses
 * for better agent consumption
 */

export function filterWorkspace(data: any) {
  return {
    id: data.id,
    name: data.name,
    description: data.description,
    defaultSpaceId: data.defaultSpaceId,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    deletedAt: data.deletedAt,
  };
}

export function filterSpace(space: any) {
  return {
    id: space.id,
    name: space.name,
    description: space.description,
    slug: space.slug,
    visibility: space.visibility,
    createdAt: space.createdAt,
    updatedAt: space.updatedAt,
    deletedAt: space.deletedAt,
  };
}

export function filterGroup(group: any) {
  return {
    id: group.id,
    name: group.name,
    description: group.description,
    workspaceId: group.workspaceId,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
    deletedAt: group.deletedAt,
  };
}

export function filterPage(page: any, content?: string, subpages?: any[]) {
  return {
    id: page.id,
    title: page.title,
    parentPageId: page.parentPageId,
    spaceId: page.spaceId,
    isLocked: page.isLocked,
    createdAt: page.createdAt,
    updatedAt: page.updatedAt,
    deletedAt: page.deletedAt,
    // Include converted markdown content if valid string (even empty)
    ...(typeof content === "string" && { content }),
    // Include subpages if provided
    ...(subpages &&
      subpages.length > 0 && {
        subpages: subpages.map((p) => ({ id: p.id, title: p.title })),
      }),
  };
}

export function filterComment(comment: any) {
  return {
    id: comment.id,
    pageId: comment.pageId,
    content: comment.content,
    selection: comment.selection,
    type: comment.type,
    parentCommentId: comment.parentCommentId,
    creatorId: comment.creatorId,
    creator: comment.creator
      ? { id: comment.creator.id, name: comment.creator.name, avatarUrl: comment.creator.avatarUrl }
      : undefined,
    lastEditedById: comment.lastEditedById,
    editedAt: comment.editedAt,
    resolvedAt: comment.resolvedAt,
    resolvedById: comment.resolvedById,
    resolvedBy: comment.resolvedBy
      ? { id: comment.resolvedBy.id, name: comment.resolvedBy.name, avatarUrl: comment.resolvedBy.avatarUrl }
      : undefined,
    spaceId: comment.spaceId,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
  };
}

export function filterSearchResult(result: any) {
  return {
    id: result.id,
    title: result.title,
    parentPageId: result.parentPageId,
    createdAt: result.createdAt,
    updatedAt: result.updatedAt,
    rank: result.rank,
    highlight: result.highlight,
    spaceId: result.space?.id,
    spaceName: result.space?.name,
  };
}
