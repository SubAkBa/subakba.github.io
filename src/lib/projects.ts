import { getCollection, type CollectionEntry } from 'astro:content';

export type Project = CollectionEntry<'projects'>;

export async function getPublishedProjects(): Promise<Project[]> {
  const projects = await getCollection('projects', ({ data }) => !data.draft);
  return projects.sort((first, second) =>
    first.data.order - second.data.order || first.id.localeCompare(second.id),
  );
}

export async function getFeaturedProjects(): Promise<Project[]> {
  return (await getPublishedProjects()).filter((project) => project.data.featured);
}
