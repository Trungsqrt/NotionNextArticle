export default function NotionVideo({ block }) {
  // Extract URL based on the video type
  const video = block.video;
  const type = video.type;
  const url = type === 'external' ? video.external.url : video.file.url;

  // Extract caption if available
  const caption = video.caption?.[0]?.plain_text || '';

  // Handle YouTube external links by converting them to embed URLs
  const isYouTube = url.includes('youtube.com') || url.includes('youtu.be');

  if (isYouTube) {
    // Basic regex to extract YouTube video ID
    const videoId = url.split('v=')[1]?.split('&')[0] || url.split('youtu.be/')[1];
    const embedUrl = `https://www.youtube.com/embed/${videoId}`;

    return (
      <div className="my-6 w-full flex flex-col items-center">
        <div className="relative w-full aspect-video rounded-xl overflow-hidden border border-neutral-200/60 dark:border-neutral-800/60 shadow-sm">
          <iframe
            src={embedUrl}
            title={caption || "YouTube video player"}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
            className="absolute top-0 left-0 w-full h-full"
          />
        </div>
        {caption && <p className="mt-2 text-sm text-neutral-500">{caption}</p>}
      </div>
    );
  }

  // Handle direct file uploads (e.g., .mp4 from Notion)
  return (
    <div className="my-6 w-full flex flex-col items-center">
      <video
        controls
        className="w-full rounded-xl border border-neutral-200/60 dark:border-neutral-800/60 shadow-sm"
      >
        <source src={url} type="video/mp4" />
        {/* Fallback text for older browsers */}
        Your browser does not support the video tag.
      </video>
      {caption && <p className="mt-2 text-sm text-neutral-500">{caption}</p>}
    </div>
  );
}
