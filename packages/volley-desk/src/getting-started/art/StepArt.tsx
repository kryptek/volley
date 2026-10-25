import "../../styles/getting-started-art.css";
import { ART_DIR_URL, useArtMap } from "./assetMap";
import { SCENE_ALT, type SceneId } from "./ids";
import { SCENES, type SceneProps } from "./scenes";

/** A wizard step's art: the raster the asset map names for `scene`, else its vector scene. */
export function StepArt({ scene, size, className }: SceneProps & { scene: SceneId }) {
  const file = useArtMap()[scene];
  if (file) {
    return (
      <img
        src={`${ART_DIR_URL}${file}`}
        alt={SCENE_ALT[scene]}
        data-scene={scene}
        className={className ? `gs-art ${className}` : "gs-art"}
        width={size}
        height={size}
      />
    );
  }
  const Scene = SCENES[scene];
  return <Scene {...(size === undefined ? {} : { size })} {...(className ? { className } : {})} />;
}
