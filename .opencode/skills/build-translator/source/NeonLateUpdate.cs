using UnityEngine;

namespace NeonTranslatorDX
{
    [DefaultExecutionOrder(10000)]
    public class NeonLateUpdate : MonoBehaviour
    {
        private void LateUpdate()
        {
            TranslatorPlugin.PopulateAllTextPublic();
        }
    }
}
