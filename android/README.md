# Ojo de Dios · APK

Wrapper Android mínimo: una Activity con WebView que carga https://god-eye-lyart.vercel.app

- package `com.ojodedios.app`
- minSdk 24, targetSdk 34
- JavaScript y DOM storage habilitados, sin contenido mixto
- botón atrás navega dentro de la app

## Compilar sin Gradle

Requiere JDK 17, Android SDK build-tools 34 y platform 34.

```bash
export ANDROID_HOME=$HOME/Android/Sdk
BT=$ANDROID_HOME/build-tools/34.0.0
AJ=$ANDROID_HOME/platforms/android-34/android.jar
cd android
$BT/aapt2 compile --dir res -o compiled.zip
$BT/aapt2 link -o base.apk -I $AJ --manifest AndroidManifest.xml -R compiled.zip --java gen --min-sdk-version 24 --target-sdk-version 34 --auto-add-overlay
javac -source 8 -target 8 -bootclasspath $AJ -d obj java/com/ojodedios/app/MainActivity.java gen/com/ojodedios/app/R.java
$BT/d8 --lib $AJ --min-api 24 --output dex $(find obj -name '*.class')
python3 -c "import zipfile;shutil.copy('base.apk','work.apk');z=zipfile.ZipFile('work.apk','a');z.write('dex/classes.dex','classes.dex');z.close()"
$BT/zipalign -f 4 work.apk aligned.apk
keytool -genkeypair -keystore ks.jks -storepass ojodedios -keypass ojodedios -alias ojo -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Ojo de Dios, O=Personal, C=MX"
$BT/apksigner sign --ks ks.jks --ks-pass pass:ojodedios --key-pass pass:ojodedios --out OjoDeDios.apk aligned.apk
```
