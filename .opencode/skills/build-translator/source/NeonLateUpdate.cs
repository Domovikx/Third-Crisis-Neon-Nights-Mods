using UnityEngine;

namespace NeonTranslatorDX
{
    [DefaultExecutionOrder(10000)]
    public class NeonLateUpdate : MonoBehaviour
    {
        private void LateUpdate()
        {
            TranslatorPlugin.PopulateAllTextPublic();
            NeonFontDebug.HandleInput();
            // TEMPORARY UI research hook: F10 dumps the metrics of whatever
            // screen is open (used to measure the game's own popups).
            if (Input.GetKeyDown(KeyCode.F10)) NeonUiProbe.Run();
        }
    }
}
